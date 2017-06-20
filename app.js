require('dotenv').config();
const fs = require('fs');
const restify = require('restify');
const builder = require('botbuilder');

// services
const ticketsApi = require('./ticketsApi');

// config
const listenPort = process.env.port || process.env.PORT || 3978;
const ticketSubmissionUrl = process.env.TICKET_SUBMISSION_URL || `http://localhost:${listenPort}`;

// Setup Restify Server
var server = restify.createServer();
server.listen(listenPort, '::', () => {
    console.log('Server Up');
});

// Setup body parser and tickets api
server.use(restify.bodyParser());
server.post('/api/tickets', ticketsApi);

// Create chat connector for communicating with the Bot Framework Service
var connector = new builder.ChatConnector({
    appId: process.env.MICROSOFT_APP_ID,
    appPassword: process.env.MICROSOFT_APP_PASSWORD
});

// Listen for messages from users
server.post('/api/messages', connector.listen());

// Receive messages from the user and respond by echoing each message back (prefixed with 'You said:')
// var bot = new builder.UniversalBot(connector, [
//     (session, args, next) => {
//         session.send('You said: ' + session.message.text + ' which was ' + session.message.text.length + ' characters');
//     }
// ]);

var bot = new builder.UniversalBot(connector, [
    (session, args, next) => {
        session.send('Hi! I\'m the help desk bot and I can help you create a ticket.');
        builder.Prompts.text(session, 'First, please briefly describe your problem to me.');
    },
    (session, result, next) => {
        session.dialogData.description = result.response;

        var choices = ['high', 'normal', 'low'];
        builder.Prompts.choice(session, 'Which is the severity of this problem?', choices, {
            listStyle: builder.ListStyle.button
        });
    },
    (session, result, next) => {
        session.dialogData.severity = result.response.entity;

        builder.Prompts.text(session, 'Which would be the category for this ticket (software, hardware, networking, security or other)?');
    },
    (session, result, next) => {
        session.dialogData.category = result.response;

        var message = `Great! I'm going to create a "${session.dialogData.severity}" severity ticket in the "${session.dialogData.category}" category. ` +
            `The description I will use is "${session.dialogData.description}". Can you please confirm that this information is correct?`;

        builder.Prompts.confirm(session, message, {
            listStyle: builder.ListStyle.button
        });
    },
    (session, result, next) => {
        if (result.response) {
            var data = {
                category: session.dialogData.category,
                severity: session.dialogData.severity,
                description: session.dialogData.description,
            }

            const client = restify.createJsonClient({
                url: ticketSubmissionUrl
            });
            session.sendTyping();
            client.post('/api/tickets', data, (err, request, response, ticketId) => {
                if (err || ticketId == -1) {
                    session.send('Something went wrong while I was saving your ticket. Please try again later.')
                } else {
                    session.send(new builder.Message(session).addAttachment({
                        contentType: "application/vnd.microsoft.card.adaptive",
                        content: createCard(ticketId, data)
                    }));
                }

                session.endDialog();
            });
        } else {
            session.endDialog('Ok. The ticket was not created. You can start again if you want.');
        }
    }
]).on('conversationUpdate', function (message) {
    console.log("calling this guy");
    console.log(message.user);
    // how do we check is user and not bot?
    
    var name = message.user ? message.user.name : null;
    var reply = new builder.Message()
        .address(message.address)
        .text("Hello %s... Thanks for adding me.", name || 'there');
    console.log(reply);
    bot.send(reply);
});

const createCard = (ticketId, data) => {
    var cardTxt = fs.readFileSync('./cards/ticket.json', 'UTF-8');

    cardTxt = cardTxt.replace(/{ticketId}/g, ticketId)
        .replace(/{severity}/g, data.severity)
        .replace(/{category}/g, data.category)
        .replace(/{description}/g, data.description);

    return JSON.parse(cardTxt);
};