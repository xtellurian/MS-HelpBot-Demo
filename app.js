require('dotenv').config();
const restify = require('restify');
const builder = require('botbuilder');

// Setup Restify Server
var server = restify.createServer();
server.listen(process.env.port || process.env.PORT || 3978, () => {
    console.log('%s listening to %s', server.name, server.url);
});

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
        session.send(`Got it. Your problem is "${session.dialogData.description}"`);
        session.endDialog();
    }
]);