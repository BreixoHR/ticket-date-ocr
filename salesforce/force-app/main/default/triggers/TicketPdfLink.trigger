trigger TicketPdfLink on ContentDocumentLink(after insert) {
    TicketPdfLinkHandler.afterInsert(Trigger.new);
}
