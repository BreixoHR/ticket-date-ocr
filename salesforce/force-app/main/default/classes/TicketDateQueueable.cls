/**
 * Envía el PDF de una entrada al servicio ticket-date-ocr y compara la fecha detectada con la
 * fecha de visita esperada del registro Ticket__c.
 *
 * - Procesa un documento por ejecución y encadena el resto: cada PDF puede ocupar varios MB
 *   de heap y el callout puede tardar hasta 2 minutos.
 * - El endpoint y la API key viven en la Named Credential "Ticket_Date_OCR"
 *   (HTTPS + cabecera X-Api-Key desde una External Credential): nada de URLs ni secretos en código.
 * - Si el servicio responde 202 (procesando) o 503 (saturado / OCR caído) se reintenta con retraso.
 */
public with sharing class TicketDateQueueable implements Queueable, Database.AllowsCallouts {
    public class Job {
        public Id ticketId;
        public Id contentDocumentId;
        public Integer attempt = 0;

        public Job(Id ticketId, Id contentDocumentId) {
            this.ticketId = ticketId;
            this.contentDocumentId = contentDocumentId;
        }
    }

    @TestVisible
    private static final String ENDPOINT = 'callout:Ticket_Date_OCR/analyze';
    @TestVisible
    private static final Integer MAX_ATTEMPTS = 3;
    private static final Integer RETRY_DELAY_MINUTES = 2;

    private final List<Job> jobs;

    public TicketDateQueueable(List<Job> jobs) {
        this.jobs = jobs;
    }

    public void execute(QueueableContext context) {
        if (jobs.isEmpty()) {
            return;
        }
        Job current = jobs.remove(0);
        Job retry = process(current);

        if (Test.isRunningTest()) {
            return; // en tests no se pueden encadenar Queueables
        }
        if (retry != null) {
            System.enqueueJob(new TicketDateQueueable(new List<Job>{ retry }), RETRY_DELAY_MINUTES);
        }
        if (!jobs.isEmpty()) {
            System.enqueueJob(new TicketDateQueueable(jobs));
        }
    }

    /** Devuelve el job a reintentar, o null si ha terminado. */
    @TestVisible
    private Job process(Job job) {
        Ticket__c ticket = new Ticket__c(Id = job.ticketId);
        try {
            List<ContentVersion> versions = [
                SELECT VersionData
                FROM ContentVersion
                WHERE ContentDocumentId = :job.contentDocumentId AND IsLatest = TRUE AND FileExtension = 'pdf'
                LIMIT 1
            ];
            if (versions.isEmpty()) {
                return null;
            }

            HttpResponse res = callService(job.ticketId, EncodingUtil.base64Encode(versions[0].VersionData));
            Integer status = res.getStatusCode();

            if ((status == 202 || status == 503) && job.attempt + 1 < MAX_ATTEMPTS) {
                job.attempt++;
                ticket.Pdf_Date_Status__c = 'Pending';
                update ticket;
                return job;
            }
            if (status != 200) {
                markError(ticket, 'HTTP ' + status);
                return null;
            }

            AnalyzeResponse body = (AnalyzeResponse) JSON.deserialize(res.getBody(), AnalyzeResponse.class);
            applyResult(job.ticketId, ticket, body);
        } catch (Exception e) {
            markError(ticket, e.getTypeName());
        }
        return null;
    }

    private static HttpResponse callService(Id ticketId, String base64Pdf) {
        HttpRequest req = new HttpRequest();
        req.setEndpoint(ENDPOINT);
        req.setMethod('POST');
        req.setHeader('Content-Type', 'application/json');
        req.setTimeout(120000);
        req.setBody(
            JSON.serialize(new Map<String, Object>{ 'recordId' => String.valueOf(ticketId), 'fileBase64' => base64Pdf })
        );
        return new Http().send(req);
    }

    private static void applyResult(Id ticketId, Ticket__c ticket, AnalyzeResponse body) {
        Ticket__c current = [SELECT Expected_Visit_Date__c FROM Ticket__c WHERE Id = :ticketId];
        Date detected = String.isBlank(body.visitDate) ? null : Date.valueOf(body.visitDate);

        ticket.Pdf_Visit_Date__c = detected;
        ticket.Pdf_Detected_Dates__c = body.dates == null ? null : String.join(body.dates, ', ').left(255);
        ticket.Pdf_Date_Source__c = body.source;
        ticket.Pdf_Date_Error__c = null;

        if (detected == null) {
            ticket.Pdf_Date_Status__c = 'Not Found';
        } else if (current.Expected_Visit_Date__c == null) {
            ticket.Pdf_Date_Status__c = 'Pending';
        } else {
            ticket.Pdf_Date_Status__c = detected == current.Expected_Visit_Date__c ? 'Match' : 'Mismatch';
        }
        update ticket;
    }

    private static void markError(Ticket__c ticket, String reason) {
        ticket.Pdf_Date_Status__c = 'Error';
        ticket.Pdf_Date_Error__c = reason.left(255);
        update ticket;
    }

    public class AnalyzeResponse {
        public Boolean success;
        public String recordId;
        public String visitDate;
        public List<String> dates;
        public String source;
    }
}
