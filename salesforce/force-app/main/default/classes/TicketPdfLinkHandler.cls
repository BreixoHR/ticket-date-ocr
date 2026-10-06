/**
 * Cuando se adjunta un fichero a un Ticket__c, encola su análisis.
 * Un único Queueable para todo el lote del trigger (el Queueable procesa y encadena de uno en uno).
 */
public with sharing class TicketPdfLinkHandler {
    public static void afterInsert(List<ContentDocumentLink> links) {
        List<TicketDateQueueable.Job> jobs = new List<TicketDateQueueable.Job>();
        Schema.SObjectType ticketType = Ticket__c.SObjectType;

        for (ContentDocumentLink link : links) {
            if (link.LinkedEntityId != null && link.LinkedEntityId.getSObjectType() == ticketType) {
                jobs.add(new TicketDateQueueable.Job(link.LinkedEntityId, link.ContentDocumentId));
            }
        }
        if (!jobs.isEmpty()) {
            System.enqueueJob(new TicketDateQueueable(jobs));
        }
    }
}
