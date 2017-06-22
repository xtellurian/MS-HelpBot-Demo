// TODO task 6 on exercise 4

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const restify = require('restify');
const builder = require('botbuilder');
const azureSearch = require('./azureSearchApiClient');
const card = require('./articlesCard');

const imageSearch = require('./imageSearchApiClient');
const imageSearchService = imageSearch({
    apiKey: process.env.MICROSOFT_BING_IMAGE_SEARCH_APIKEY
});

// config
const listenPort = process.env.port || process.env.PORT || 3978;
const ticketSubmissionUrl = process.env.TICKET_SUBMISSION_URL || `http://localhost:${listenPort}`;

// services
const ticketsApi = require('./ticketsApi');
const azureSearchQuery = azureSearch({
    searchName: process.env.AZURE_SEARCH_ACCOUNT,
    indexName: process.env.AZURE_SEARCH_INDEX,
    searchKey: process.env.AZURE_SEARCH_KEY
});
const HandOffRouter = require('./handoff/router');
const HandOffCommand = require('./handoff/command');




// Setup Restify Server
var server = restify.createServer();
server.listen(listenPort, '::', () => {
    console.log('Server Up');
});


// Setup body parser and tickets api
server.use(restify.bodyParser());
server.post('/api/tickets', ticketsApi.add);
server.get('/api/tickets/:id', ticketsApi.get); // this must come before the static serve command below

server.get(/\/?.*/, restify.serveStatic({
    directory: path.join(__dirname, 'web-ui'),
    default: 'default.htm'
}));

// Create chat connector for communicating with the Bot Framework Service
var connector = new builder.ChatConnector({
    appId: process.env.MICROSOFT_APP_ID,
    appPassword: process.env.MICROSOFT_APP_PASSWORD
});

// Listen for messages from users
server.post('/api/messages', connector.listen());

// backchanel event
const createEvent = (eventName, value, address) => {
    var msg = new builder.Message().address(address);
    msg.data.type = 'event';
    msg.data.name = eventName;
    msg.data.value = value;
    return msg;
};

var bot = new builder.UniversalBot(connector, (session) => {
    session.endDialog(`I'm sorry, I did not understand '${session.message.text}'.\nType 'help' to know more about me :)`);
});

// set up router
const handOffRouter = new HandOffRouter(bot, (session) => {
    return session.conversationData.isAgent;
});
const handOffCommand = new HandOffCommand(handOffRouter);
// tell bot to use router and command middleware
bot.use(handOffCommand.middleware());
bot.use(handOffRouter.middleware());


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

// backchanel event
bot.on(`event`, function (event) {
    var msg = new builder.Message().address(event.address);
    msg.data.textLocale = 'en-us';
    if (event.name === 'showDetailsOf') {
        azureSearchQuery('$filter=' + encodeURIComponent(`title eq '${event.value}'`), (error, result) => {
            if (error || !result.value[0]) {
                msg.data.text = 'Sorry, I could not find that article.';
            } else {
                msg.data.text = result.value[0].text;
            }
            bot.send(msg);
        });
    }
});

// agent login dialog menu
bot.dialog('AgentMenu', [
    (session, args) => {
        session.conversationData.isAgent = true;
        session.endDialog(`Welcome back human agent, there are ${handOffRouter.pending()} users waiting in the queue.\n\nType _agent help_ for more details.`);
    }
]).triggerAction({
    matches: /^\/agent login/
});

// hand off to human dialog
bot.dialog('HandOff',
    (session, args, next) => {
        if (handOffCommand.queueMe(session)) {
            var waitingPeople = handOffRouter.pending() > 1 ? `, there are ${handOffRouter.pending()-1} users waiting` : '';
            session.send(`Connecting you to the next available human agent... please wait${waitingPeople}.`);
        }
        session.endDialog();
    }
).triggerAction({
    matches: 'HandOffToHuman'
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
        
        // send event to embedded bot via backchannel
        azureSearchQuery(`search=${encodeURIComponent(session.message.text)}`, (err, result) => {
            if (err || !result.value) return;
            var event = createEvent('searchResults', result.value, session.message.address);
            session.send(event);
        });

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
            session.dialogData.ticketNumber = ticketNumber;
            session.sendTyping();

            builder.Prompts.text(session, "OK I'll look up ticket " + ticketNumber + " for you...");

            const client = restify.createJsonClient({
                url: ticketSubmissionUrl
            });
            session.sendTyping();
            console.log("looking up ticket number " + ticketNumber);
            client.get('/api/tickets/' + ticketNumber, (err, request, response, data) => {
                if (err || !data) {
                    session.send('Sorry, I could not find ticket number ' + ticketNumber);
                } else {
                    console.log('found ticket: ', data);
                    session.send(new builder.Message(session).addAttachment({
                        contentType: "application/vnd.microsoft.card.adaptive",
                        content: createCard(ticketNumber, data)
                    }));
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
            session.endDialog(`I'm the help desk bot and I can help you create a ticket or explore the knowledge base.\n` +
            `You can tell me things like _I need to reset my password_ or _explore hardware articles_.`);
        }

    }
).triggerAction({
    matches: 'help'
});

bot.dialog('ShowKBResults', [
    (session, args) => {
        if (args.result.value.length > 0) {
            var msg = new builder.Message(session).attachmentLayout(builder.AttachmentLayout.carousel);
            imageSearchService(args.result.value[0].category, (err, imgUrl) => {
                args.result.value.forEach((faq, i) => {
                    msg.addAttachment(card(faq, imgUrl));
                });
                session.send(`These are some articles I\'ve found in the knowledge base for _'${args.originalText}'_, click **More details** to read the full article:`);
                session.endDialog(msg);
            })
            // args.result.value.forEach((faq, i) => {
            // card(faq, imageSearchService(faq.category, (err, url) => {return url}))
            //card(faq, null) // previous call where query ie url was null
            //);
            // });
            // session.send(`These are some articles I\'ve found in the knowledge base for _'${args.originalText}'_, click **More details** to read the full article:`);
            // session.endDialog(msg);
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