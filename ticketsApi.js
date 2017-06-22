var tickets = [];
var lastTicketId = 1;

 function add(req, res) {
    console.log('Ticket received: ', req.body);
    let ticketId = lastTicketId++;
    var ticket = req.body;
    ticket.id = ticketId;
    tickets.push(ticket);

    res.send(ticketId.toString());
};

function get(req, res){
    console.log('called into tickets GET api');
    console.log('params' , req.params);
    var id = req.params.id;
    console.log('there are ' + tickets.length + ' saved tickets');
    var ticket = tickets.find( (t) => t.id == id);
    console.log(tickets[0]);
    console.log('API: found ticket: ', ticket);
    res.send(ticket);
}

module.exports = {
    add : add,
    get: get
}