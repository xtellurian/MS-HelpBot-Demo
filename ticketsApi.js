var tickets = {};
var lastTicketId = 1;

 function add(req, res) {
    console.log('Ticket received: ', req.body);
    let ticketId = lastTicketId++;
    var ticket = req.body;
    ticket.id = ticketId;
    tickets[ticketId] = ticket;

    res.send(ticketId.toString());
};

function get(req, res){
    console.log('called into tickets GET api');
    console.log('params' , req.params);
    var id = req.params.id;
    var ticket = tickets[id];
    console.log('found ticket', ticket);
    res.send(ticket.status);
}

module.exports = {
    add : add,
    get: get
}