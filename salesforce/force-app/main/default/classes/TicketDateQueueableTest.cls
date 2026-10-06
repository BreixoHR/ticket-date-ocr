@IsTest
private class TicketDateQueueableTest {
    private class ServiceMock implements HttpCalloutMock {
        private final Integer status;
        private final String body;
        public HttpRequest lastRequest;

        ServiceMock(Integer status, String body) {
            this.status = status;
            this.body = body;
        }

        public HttpResponse respond(HttpRequest req) {
            lastRequest = req;
            HttpResponse res = new HttpResponse();
            res.setStatusCode(status);
            res.setHeader('Content-Type', 'application/json');
            res.setBody(body);
            return res;
        }
    }

    private static Ticket__c newTicket(Date expected) {
        Ticket__c t = new Ticket__c(Expected_Visit_Date__c = expected);
        insert t;
        return t;
    }

    // Insertar un ContentVersion con FirstPublishLocationId crea el ContentDocumentLink → dispara el trigger
    private static void attachPdf(Id ticketId) {
        insert new ContentVersion(
            Title = 'entrada',
            PathOnClient = 'entrada.pdf',
            VersionData = Blob.valueOf('%PDF-1.4 fake'),
            FirstPublishLocationId = ticketId
        );
    }

    private static Ticket__c reload(Id ticketId) {
        return [
            SELECT Pdf_Visit_Date__c, Pdf_Date_Status__c, Pdf_Detected_Dates__c, Pdf_Date_Source__c, Pdf_Date_Error__c
            FROM Ticket__c
            WHERE Id = :ticketId
        ];
    }

    @IsTest
    static void matchingDate() {
        Ticket__c t = newTicket(Date.newInstance(2026, 5, 27));
        ServiceMock mock = new ServiceMock(
            200,
            '{"success":true,"visitDate":"2026-05-27","dates":["2026-04-10","2026-05-27"],"source":"oci"}'
        );
        Test.setMock(HttpCalloutMock.class, mock);

        Test.startTest();
        attachPdf(t.Id);
        Test.stopTest();

        Ticket__c r = reload(t.Id);
        Assert.areEqual('Match', r.Pdf_Date_Status__c);
        Assert.areEqual(Date.newInstance(2026, 5, 27), r.Pdf_Visit_Date__c);
        Assert.areEqual('2026-04-10, 2026-05-27', r.Pdf_Detected_Dates__c);
        Assert.areEqual('oci', r.Pdf_Date_Source__c);
        Assert.areEqual('callout:Ticket_Date_OCR/analyze', mock.lastRequest.getEndpoint());
        Assert.isTrue(mock.lastRequest.getBody().contains('"recordId":"' + t.Id + '"'));
    }

    @IsTest
    static void differentDate() {
        Ticket__c t = newTicket(Date.newInstance(2026, 5, 28));
        Test.setMock(
            HttpCalloutMock.class,
            new ServiceMock(
                200,
                '{"success":true,"visitDate":"2026-05-27","dates":["2026-05-27"],"source":"text-layer"}'
            )
        );

        Test.startTest();
        attachPdf(t.Id);
        Test.stopTest();

        Assert.areEqual('Mismatch', reload(t.Id).Pdf_Date_Status__c);
    }

    @IsTest
    static void noDateFound() {
        Ticket__c t = newTicket(Date.newInstance(2026, 5, 28));
        Test.setMock(HttpCalloutMock.class, new ServiceMock(200, '{"success":true,"visitDate":null,"dates":[]}'));

        Test.startTest();
        attachPdf(t.Id);
        Test.stopTest();

        Assert.areEqual('Not Found', reload(t.Id).Pdf_Date_Status__c);
    }

    @IsTest
    static void serviceBusyIsRetried() {
        Ticket__c t = newTicket(Date.newInstance(2026, 5, 28));
        Test.setMock(HttpCalloutMock.class, new ServiceMock(503, '{"success":false}'));

        Test.startTest();
        attachPdf(t.Id);
        Test.stopTest();

        Assert.areEqual('Pending', reload(t.Id).Pdf_Date_Status__c);
    }

    @IsTest
    static void lastAttemptMarksError() {
        Ticket__c t = newTicket(Date.newInstance(2026, 5, 28));
        // Sin FirstPublishLocationId: el fichero no se enlaza al ticket y el trigger no encola nada
        ContentVersion cv = new ContentVersion(
            Title = 'entrada',
            PathOnClient = 'entrada.pdf',
            VersionData = Blob.valueOf('%PDF-1.4 fake')
        );
        insert cv;
        Id docId = [SELECT ContentDocumentId FROM ContentVersion WHERE Id = :cv.Id].ContentDocumentId;
        Test.setMock(HttpCalloutMock.class, new ServiceMock(503, '{"success":false}'));

        TicketDateQueueable.Job lastTry = new TicketDateQueueable.Job(t.Id, docId);
        lastTry.attempt = TicketDateQueueable.MAX_ATTEMPTS - 1;

        // DML antes de startTest y callout dentro: el patrón permitido en tests
        Test.startTest();
        TicketDateQueueable.Job retry = new TicketDateQueueable(new List<TicketDateQueueable.Job>()).process(lastTry);
        Test.stopTest();

        Assert.isNull(retry, 'en el último intento no se reintenta');
        Ticket__c r = reload(t.Id);
        Assert.areEqual('Error', r.Pdf_Date_Status__c);
        Assert.areEqual('HTTP 503', r.Pdf_Date_Error__c);
    }

    @IsTest
    static void filesOnOtherObjectsAreIgnored() {
        Account a = new Account(Name = 'Otro objeto');
        insert a;
        ServiceMock mock = new ServiceMock(200, '{}');
        Test.setMock(HttpCalloutMock.class, mock);

        Test.startTest();
        attachPdf(a.Id);
        Test.stopTest();

        Assert.isNull(mock.lastRequest, 'no debe llamar al servicio');
    }
}
