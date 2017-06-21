// TODO task 6 on exercise 4

require('dotenv').config();
const fs = require('fs');
const restify = require('restify');
const builder = require('botbuilder');
const azureSearch = require('./azureSearchApiClient');
const card = require('./articlesCard');

// services
const ticketsApi = require('./ticketsApi');
const azureSearchQuery = azureSearch({
    searchName: process.env.AZURE_SEARCH_ACCOUNT,
    indexName: process.env.AZURE_SEARCH_INDEX,
    searchKey: process.env.AZURE_SEARCH_KEY
});

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
server.post('/api/tickets', ticketsApi.add);
server.get('/api/tickets/:id', ticketsApi.get);

// Create chat connector for communicating with the Bot Framework Service
var connector = new builder.ChatConnector({
    appId: process.env.MICROSOFT_APP_ID,
    appPassword: process.env.MICROSOFT_APP_PASSWORD
});

// Listen for messages from users
server.post('/api/messages', connector.listen());


var bot = new builder.UniversalBot(connector, (session) => {
    session.endDialog(`I'm sorry, I did not understand '${session.message.text}'.\nType 'help' to know more about me :)`);
});

var luisRecognizer = new builder.LuisRecognizer(process.env.LUIS_MODEL_URL).onEnabled(function (context, callback) {
    var enabled = context.dialogStack().length === 0 || context.dialogStack()[0].id === '*:SubmitTicket';
    console.log('luis enabled:' + enabled);
    callback(null, enabled);
});
bot.recognizer(luisRecognizer);

bot.on('conversationUpdate', function (message) {

    if (message.membersAdded[0].id === message.user.id) {
        var name = message.user ? message.user.name : null;
        var reply = new builder.Message()
            .address(message.address)
            .text("Hello %s... Thanks for adding me.", name || 'there');
        bot.send(reply);
    }
});



bot.dialog('SubmitTicket', [
    (session, args, next) => {
        var category = builder.EntityRecognizer.findEntity(args.intent.entities, 'category');
        var severity = builder.EntityRecognizer.findEntity(args.intent.entities, 'severity');

        if (category && category.resolution.values.length > 0) {
            session.dialogData.category = category.resolution.values[0];
        }

        if (severity && severity.resolution.values.length > 0) {
            session.dialogData.severity = severity.resolution.values[0];
        }

        session.dialogData.description = session.message.text;

        if (!session.dialogData.severity) {
            var choices = ['high', 'normal', 'low'];
            builder.Prompts.choice(session, 'Which is the severity of this problem?', choices, {
                listStyle: builder.ListStyle.button
            });
        } else {
            next();
        }
    },
    (session, result, next) => {
        if (!session.dialogData.severity) {
            session.dialogData.severity = result.response.entity;
        }

        if (!session.dialogData.category) {
            builder.Prompts.text(session, 'Which would be the category for this ticket (software, hardware, network, and so on)?');
        } else {
            next();
        }
    },
    (session, result, next) => {
        if (!session.dialogData.category) {
            session.dialogData.category = result.response;
        }

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
                status: 'created'
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
]).triggerAction({
    matches: 'SubmitTicket'
}).beginDialogAction('help', 'help', {
    matches: 'help',
    onFindAction: (context, callback) => {
        if (context.message === 'cancel') {
            callback(null, 0.1); // we always want help to be triggered
        } else {
            callback(null, 0.99); // we always want help to be triggered
        }

    }
}).cancelAction('cancel', "I'm not going to submit that ticket", {
    matches: /cancel/
});

bot.dialog('ExploreKnowledgeBase', [
    (session, args, next) => {
        var category = builder.EntityRecognizer.findEntity(args.intent.entities, 'category');

        if (!category) {
            // retrieve facets
            azureSearchQuery('facet=category', (error, result) => {
                if (error) {
                    session.endDialog('Ooops! Something went wrong while contacting Azure Search. Please try again later.');
                } else {
                    var choices = result['@search.facets'].category.map(item => `${item.value} (${item.count})`);
                    builder.Prompts.choice(session, 'Let\'s see if I can find something in the knowledge base for you. Which category is your question about?', choices, {
                        listStyle: builder.ListStyle.button
                    });
                }
            });
        } else {
            if (!session.dialogData.category) {
                session.dialogData.category = category.entity;
            }

            next();
        }
    },
    (session, args) => {
        var category;

        if (session.dialogData.category) {
            category = session.dialogData.category;
        } else {
            category = args.response.entity.replace(/\s\([^)]*\)/, '');
        }

        // search by category
        azureSearchQuery('$filter=' + encodeURIComponent(`category eq '${category}'`), (error, result) => {
            if (error) {
                session.endDialog('Ooops! Something went wrong while contacting Azure Search. Please try again later.');
            } else {
                session.replaceDialog('ShowKBResults', {
                    result,
                    originalText: category
                });
            }
        });
    }
]).triggerAction({
    matches: 'exploreKnowledgeBase'
});

bot.dialog('SearchKB', [
        (session) => {
            session.sendTyping();
            azureSearchQuery(`search=${encodeURIComponent(session.message.text.substring('search about '.length))}`, (err, result) => {
                if (err) {
                    session.send('Ooops! Something went wrong while contacting Azure Search. Please try again later.');
                    return;
                }
                session.replaceDialog('ShowKBResults', {
                    result,
                    originalText: session.message.text
                });
            });
        }
    ])
    .triggerAction({
        matches: /^search about (.*)/i
    });

bot.dialog('status', [
    (session, args, next) => {
        if (!session.dialogData.ticketNumber) {
            builder.Prompts.text(session, "What's your ticket number?");
        }
    },
    (session, args, next) => {
        var ticketNumber = parseInt(session.message.text, 10);
        if (!isNaN(ticketNumber)) {
            console.log('found a ticket number');
            session.dialogData.ticketNumber = ticketNumber;
            session.sendTyping();

            builder.Prompts.text(session, "OK I'll look up ticket " + ticketNumber + " for you...");

            const client = restify.createJsonClient({
                url: ticketSubmissionUrl
            });
            session.sendTyping();
            console.log("looking up ticket number " + ticketNumber);
            client.get('/api/tickets/' + ticketNumber, (err, request, response, status) => {
                if (err || !status) {
                    session.send('Sorry, I could not find ticket number ' + ticketNumber);
                } else {
                    session.send('Ticket number' + ticketNumber + ' is ' + status);
                }

                session.endDialog();
            });
        }
    }
]).triggerAction({
    matches: 'FindStatus'
});

bot.dialog('help',
    (session, args, next) => {
        if (session.dialogStack()[0].id === '*:SubmitTicket') {
            session.endDialog("You can follow my prompts to submit a ticket. If you don't want to submit a ticket, type cancel")
        } else {
            session.endDialog(`I'm the help desk bot and I can help you create a ticket.\n` +
                `You can tell me things like _I need to reset my password_ or _I cannot print_.`);
        }

    }
).triggerAction({
    matches: 'help'
});

bot.dialog('ShowKBResults', [
    (session, args) => {
        if (args.result.value.length > 0) {
            var msg = new builder.Message(session).attachmentLayout(builder.AttachmentLayout.carousel);
            args.result.value.forEach((faq, i) => {
                msg.addAttachment(
                     card(faq, null)
                );
            });
            session.send(`These are some articles I\'ve found in the knowledge base for _'${args.originalText}'_, click **More details** to read the full article:`);
            session.endDialog(msg);
        } else {
            session.endDialog(`Sorry, I could not find any results in the knowledge base for _'${args.originalText}'_`);
        }
    }
]);

bot.dialog('DetailsOf', [
    (session, args) => {
        var title = session.message.text.substring('show me the article '.length);
        azureSearchQuery('$filter=' + encodeURIComponent(`title eq '${title}'`), (error, result) => {
            if (error || !result.value[0]) {
                session.endDialog('Sorry, I could not find that article.');
            } else {
                session.endDialog(result.value[0].text);
            }
        });
    }
]).triggerAction({
    matches: /^show me the article (.*)/i
});

const createCard = (ticketId, data) => {
    var cardTxt = fs.readFileSync('./cards/ticket.json', 'UTF-8');

    cardTxt = cardTxt.replace(/{ticketId}/g, ticketId)
        .replace(/{severity}/g, data.severity)
        .replace(/{category}/g, data.category)
        .replace(/{description}/g, data.description);

    return JSON.parse(cardTxt);
};