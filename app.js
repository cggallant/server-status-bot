const { App } = require('@slack/bolt'); 
const AWS = require("aws-sdk");
const schedule = require('node-schedule');
const storage = require('node-persist');
const { messageTemplate_allServers } = require('./messageBlocks_allservers.js');
const { messageTemplate_server2 } = require('./messageBlocks_server2.js');

// When calling the bot (@<botName>), you can include the following text to have that layout displayed
const LAYOUT1_COMMAND_TEXT = "layout 1"; // Default if not specified. The message with all servers
const LAYOUT2_COMMAND_TEXT = "layout 2"; // The message with just server 2

const REFRESH_STATUSES_ID = "RefreshStatuses"; // Used by both the Block and button itself
const LAST_CHECKED_BLOCK_ID = "LastCheckedSummary";
const SERVER1_ID = "Server1";
const SERVER2_ID = "Server2";

const SERVER1_TEXT = "Server 1";
const SERVER2_TEXT = "Server 2";

const YELLOW_CIRCLE_EMOJI = ":large_yellow_circle:";
const GREEN_CIRCLE_EMOJI = ":large_green_circle:";
const RED_CIRCLE_EMOJI = ":red_circle:";
const ONE_MOMENT_PLEASE_TEXT = ":stopwatch: One Moment Please :stopwatch:";

// EC2 instance states
const INSTANCE_PENDING = 0; // starting
const INSTANCE_RUNNING = 16;
const INSTANCE_STOPPING = 64;
const INSTANCE_STOPPED = 80;

// The region our servers are in
const REGION_VIRGINIA = "us-east-1";

// When checking the status of the servers after one is turned on or off
// (the delay is in milliseconds)
const TIMEOUT_DELAY = 15000; // 15 second delay


const app = new App({
    token: process.env.SLACK_BOT_TOKEN,
    signingSecret: process.env.SLACK_SIGNING_SECRET,

    port: process.env.PORT || 3003, 
});


// Only respond if the app is mentioned (needs bot event: app_mention and Scope: app_mentions:read)
app.event('app_mention', async({ event, context, client, say }) => {
    let layout = LAYOUT1_COMMAND_TEXT; // The all servers message by default
    let postToChannel = process.env.POST_TO_CHANNEL_DEFAULT;    
    
    // We've been asked to post just the server 2 message...
    const messageFromUser = event.text.toLowerCase();
    if (messageFromUser.indexOf(LAYOUT2_COMMAND_TEXT) !== -1) {
        layout = LAYOUT2_COMMAND_TEXT;
        postToChannel = process.env.POST_TO_CHANNEL_SERVER2;
    }
   
    // In my production app, I also check the message for "channel 2" which allows me to control where
    // the message is displayed (main channel or my private test channel). 

    // Have the message created and posted
    setMessage(true, layout, postToChannel, "");
});


// This function will be called by the app_mention function when first creating
// a message (the doInsert parameter will be 'true' if that's the case).
// 
// This function is also called if one of the servers is changing state when 
// the message was updated (as a result of the app_mention function call, the
// refresh button call, or a server being turned on or off). In these cases,
// the doInsert parameter will be 'false'.
async function setMessage(doInsert, layout, channelId, ts) {
    // Get a copy of the proper message template to adjust
    const theMessageToPost = getCopyOfMessageTemplate(layout);

    // Call into AWS for each server's status and then adjust the message
    // accordingly.
    const adjustResult = await adjustMessageWithCurrentStatuses(theMessageToPost);

    // Create an object to pass to postMessage/update
    let options = {        
        channel: channelId,        
        blocks: theMessageToPost.blocks, 
        text: "The statuses of the servers."
    };
    
    let result = null;
   
    // If we're doing an insert then...
    if (doInsert) {
        // Post the message and grab the channel id (not the human readable
        // name) and the message timestamp
        result = await app.client.chat.postMessage(options);
        channelId = result.channel;
        ts = result.ts;        

        // Can't do this sooner because, on an insert, the channel id passed 
        // into this function is the channel name, not the id (e.g. 'general'
        // rather than something like 'C02BMR9QJ9M'). We now have the actual
        // channel id from the result so we can create a key to remember 
        // which channel(s) this layout is posted to.
        const storageKey = `${layout}:${channelId}`;

        // Remember this value for the scheduled functions that check up on
        // the servers every hour or shut them down at night. If the key already
        // exists, it gets overwritten with the new info (only the latest
        // message for each layout will be updated by the scheduled functions)
        await storage.init();        
        await storage.setItem(storageKey, { "channelId": channelId, "ts": ts, "layout": layout });
    }
    else { // We're doing an update...
        try {
            // Add the message timestamp to the object and then update the message
            options.ts = ts;
            result = await app.client.chat.update(options);
        }
        catch(err) {
            // If the error is because the channel doesn't exist anymore then
            // remove the key from storage and flag that there are no servers
            // changing state so that we don't trigger the setTimeout below
            // again.
            if (typeof err.data !== "undefined" && 
                err.data.error === "message_not_found") {
                    console.log("update threw an error because the message wasn't found. Removing the message information from storage.");

                    // Build up the key that's used for the current layout & channel
                    const storageKey = `${layout}:${channelId}`;

                    // Remove the key from our cache
                    await storage.init();
                    await storage.removeItem(storageKey);
                    adjustResult.serverChangingState = false;
            } // End if
        } // catch(err)
    } // End if (doInsert)
    
    // If one of the servers is changing state then call back in a few seconds to 
    // refresh the message...
    if (adjustResult.serverChangingState) {
        console.log(`refreshExistingMessage - one of the servers is still changing state. call back in a few seconds...ts: ${ts}`);
        setTimeout(() => setMessage(false, layout, channelId, ts), TIMEOUT_DELAY);
    } // End if (aServerChangingState)
}


//============
// Buttons...
//  - Refresh (REFRESH_STATUSES_ID)
//  - Turn On/Off (all start with 'TurnOnOff_')
//
// The Refresh button click event
app.action(REFRESH_STATUSES_ID, async ({ body, action, ack, respond }) => {
    // Acknowledge the request right away and then process the request (using an
    // empty string for the region parameter to indicate to the function that it
    // is *not* to try and turn an EC2 instance on or off in this case)
    await ack();
    await handleButtonRequest("", "", body, action, respond);
});
//-----------
// Someone clicked on one of the Turn On/Turn Off buttons...
app.action(/TurnOnOff_/, async ({ body, action, ack, respond }) => {
    // Acknowledge the request right away and then process the request
    await ack();

    const region = REGION_VIRGINIA;
    let awsInstanceID = process.env.AWS_SERVER1_INSTANCE_ID; // Default to the first server

    // Strip off the 'TurnOnOff_' portion of the string to get just the server 
    // name (e.g. 'Server1').
    const serverName = action.action_id.substring(10);
    if (serverName === SERVER2_ID) {
        awsInstanceID = process.env.AWS_SERVER2_INSTANCE_ID;
    }
    
    // Update the current message and then have the other messages updated. The
    // refreshMessages function is async but we're not awaiting because it can
    // run on its own (we don't need to know its results)
    const layout = await handleButtonRequest(region, awsInstanceID, body, action, respond);
    refreshMessages(layout, body.channel.id);
});

function getCopyOfMessageTemplate(layout) {
    // Choose the proper message template 
    let message = null;
    if (layout === LAYOUT1_COMMAND_TEXT) { message = messageTemplate_allServers; } // default (message with all servers)
    else { message = messageTemplate_server2; } // Message with just server 2
    
    // Return a copy of the message because a number of the functions adjust
    // text or remove sections and we don't want that happening to the original
    // template
    return JSON.parse(JSON.stringify(message));
}

async function handleButtonRequest(region, awsInstanceID, body, action, respond) {
    // Change the 'Turn On/Off' button's text to indicate processing is 
    // happening before we go and query EC2 (so that the person who clicked 
    // on the button knows something is happening).
    const originalMessage = body.message;
    const originalText = adjustButtonText(originalMessage, action.action_id, ONE_MOMENT_PLEASE_TEXT);
    await respond({ blocks: originalMessage.blocks }, { replace_original: true });

    // This function is also called by the RefreshStatuses button because the code
    // needed is almost idential to the on/off buttons. The only difference is 
    // that no EC2 instances should be turned on/off for that button. If a region
    // was specified then this function call is for an on/off button...
    if (region !== "") {
        // If the button indicated that the instance was off then turn it on...
        if (originalText === "Turn On") { 
            await startEC2Instance(region, awsInstanceID);
        }
        else { // We're to turn off the instance...
            await stopEC2Instance(region, awsInstanceID);
        } // End if (originalText === "Turn On")
    } // End if (region !== "")

    // Determine which layout was used for the message of the button that was
    // clicked on and then get a copy of the message template to adjust.
    const layout = getLayoutFromMessage(originalMessage);
    const message = getCopyOfMessageTemplate(layout);

    // Call into AWS to get each server's status and then adjust the message
    // accordingly.
    const adjustResult = await adjustMessageWithCurrentStatuses(message);
    await respond({ blocks: message.blocks }, { replace_original: true });

    // If one of the servers is changing state then call back in a few seconds.
    if (adjustResult.serverChangingState) {
        console.log("handleButtonRequest - one of the servers is still changing state. call back in a few seconds");
        setTimeout(() => setMessage(false, layout, body.channel.id, originalMessage.ts), TIMEOUT_DELAY);
    } // End if (adjustResult.serverChangingState)

    // Let the caller know which layout was just updated
    return layout;
}


function getEc2ServiceObject(region) {
    // Switch to the requested region and then return the EC2 object needed
    // to make an AWS call.
    AWS.config.update({ region: region });
    return new AWS.EC2({apiVersion: '2016-11-15'});
}

// Based on the region and instance ids, calls into AWS to get the information
// about the instances.
/// region - string (e.g. 'us-east-1')
/// instanceIds - array of EC2 instance IDs (e.g. 'i-012abc345de22')
async function getEC2InstanceStatuses(region, instanceIDs) {
    // Request the status for the instance ids specified (need to include
    // the IncludeAllInstances flag because, otherwise, only running instance
    // data is returned and we want to know the status of all instances that
    // were specified regardless of if they're running)
    const ec2 = getEc2ServiceObject(region);
    const params = { IncludeAllInstances: true, InstanceIds: instanceIDs };
    return await ec2.describeInstanceStatus(params).promise();
}
async function startEC2Instance(region, awsInstanceID) {
    // Start the server for the instance id specified
    const ec2 = getEc2ServiceObject(region);
    const params = { InstanceIds: [awsInstanceID] };
    return await ec2.startInstances(params).promise();
}
async function stopEC2Instance(region, awsInstanceID) {
    // Start the server for the instance id specified
    const ec2 = getEc2ServiceObject(region);
    const params = { InstanceIds: [awsInstanceID] };    
    return await ec2.stopInstances(params).promise();
}

// Helper to find the status code, from the data received from AWS, for a
// particular instance
function findServerStatus(data, awsInstanceID) {
    const instanceStatuses = data.InstanceStatuses;
    const count = instanceStatuses.length;    
    let instance = null;
    for (let i = 0; i < count; i++) {
        // If the current instance is the one requested then return the status
        // code
        instance = instanceStatuses[i];
        if (instance.InstanceId === awsInstanceID) {
            return instance.InstanceState.Code;
        }
    }

    return -1; // Not found
}

// Helper that returns the server name & status, as well as the button text, for
// the message block being processed before we send it to Slack.
function getServerText(awsStatusResults, serverName) {
    // The current serverInfo doesn't exist in the temporary cache yet 
    let serverStatus = -1;
    let initialServerText = "";

    if (serverName === SERVER1_ID) {
        serverStatus = findServerStatus(awsStatusResults, process.env.AWS_SERVER1_INSTANCE_ID);
        initialServerText =  SERVER1_TEXT;
    }
    else if (serverName === SERVER2_ID) {
        serverStatus = findServerStatus(awsStatusResults, process.env.AWS_SERVER2_INSTANCE_ID);
        initialServerText =  SERVER2_TEXT;
    }

    // Return the server info to the calling function. 
    return buildServerText(serverName, serverStatus, initialServerText);
}

// Based on the server's status, this function builds up the text to display
// for the server's name/status and the button text.
function buildServerText(serverName, serverStatus, serverText) {
    let displayText = "";
    let buttonText = "";

    // Based on the server's status, adjust the text for the server 
    // name/status and for the button...
    if (serverStatus === INSTANCE_PENDING) {
        displayText = `${YELLOW_CIRCLE_EMOJI} ${serverText} _(starting)_`;
        buttonText = ""; // Used to have 'Turn Off' here originally. Testing not having a button while the server is starting
    }
    else if (serverStatus === INSTANCE_RUNNING) {
        displayText = `${GREEN_CIRCLE_EMOJI} ${serverText} _(running)_`;
        buttonText = "Turn Off";
    }
    else if (serverStatus === INSTANCE_STOPPING) {
        displayText = `${YELLOW_CIRCLE_EMOJI} ${serverText} _(stopping)_`;
        buttonText = ""; // Used to have 'Turn Off' here originally. Testing not having a button while the server is starting
    }
    else if (serverStatus === INSTANCE_STOPPED) {
        displayText = `${RED_CIRCLE_EMOJI} ${serverText} _(stopped)_`;
        buttonText = "Turn On";
    }
    // There is Shutting Down (32) which leads to Terminated (48) but those 
    // mean that the server is being deleted...
    else { 
        displayText = `${serverText} is about to be deleted`;
        buttonText = "";
    }

    return { 'serverName': serverName, 'serverStatus': serverStatus,
        'displayText': displayText, 'buttonText': buttonText };
}

// This function calls into AWS for the server statuses and then adjusts the
// message based on each server's status.
async function adjustMessageWithCurrentStatuses(theMessageToPost) {
    // Will tell the calling function if any of the displayed servers are 
    // currently changing state (turning on or off). If that's the case, the
    // caller will need to requery for the statuses in a few seconds to 
    // check again.
    const result = { "serverChangingState": false };

    // Get the info for the servers in Ohio (us-east-2)
    const awsStatusResults = await getEC2InstanceStatuses(REGION_VIRGINIA, 
        [
            process.env.AWS_SERVER1_INSTANCE_ID,
            process.env.AWS_SERVER2_INSTANCE_ID
        ]);

    let curBlock = null;
    let blockID = "";
    let serverName = "";
    let serverInfo = null;

    await storage.init();

    // Loop through the message blocks to adjust them with the current server
    // statuses
    const messageBlocks = theMessageToPost.blocks;
    let blockCount = messageBlocks.length;
    for (let i = 0; i < blockCount; i++) {
        // If the current block is a divider (horizontal line) then skip to the
        // next block (I was checking to see if the block id was undefined but
        // that's only the case if we're loading from the messageBlocks file.
        // Slack adds an ID to every item so, if we're respoinding to a click,
        // every block will have a block id. It's best to define them in the
        // file too as a result.)
        curBlock = messageBlocks[i];
        if (curBlock.type === "divider") { continue; }
        
        // Grab the block ID
        blockID = curBlock.block_id;
        if (blockID === REFRESH_STATUSES_ID) {
            // When the Refresh button is clicked, we replace the text to 
            // indicate processing until the EC2 query completes. Restore the
            // button back to its original text.
            curBlock.accessory.text.text = ":repeat: Refresh";
        }
        else if (blockID === LAST_CHECKED_BLOCK_ID) {
            // Adjust the last checked text with the current date/time
            const displayDate = new Date();
            const dateFormatOptions = { "weekday": "long", "year": "numeric", "month": "long", "day": "numeric"};
            const timeFormatOptions = { timeZone: 'America/Halifax', timeZoneName: 'short', hour: 'numeric', minute: 'numeric' }; // Display time in Atlantic Standard Time with the time zone abbreviation. Inluding hour/minute so that seconds aren't shown (more info on the options can be found here: https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Intl/DateTimeFormat/DateTimeFormat)
            curBlock.elements[0].text = "Last checked at " + displayDate.toLocaleTimeString('en-US', timeFormatOptions) + " on " + displayDate.toLocaleDateString("en-US", dateFormatOptions);
        }
        else { // This is a server row...
            // Strip off the 'TurnOnOff_' portion of the string to get just the 
            // server name (e.g. 'Server1'). Adjust the text indicating the
            // server name and status.
            serverName = blockID.substring(10);
            serverInfo = getServerText(awsStatusResults, serverName);
            curBlock.text.text = serverInfo.displayText;

            // If there is text for the button, adjust the text to reflect what
            // will happen if they click it...
            if (serverInfo.buttonText !== "") { 
                curBlock.accessory.text.text = serverInfo.buttonText; 
            } else { // No button text...
                delete curBlock.accessory; // Remove the On/Off button
            } // End if (serverInfo.buttonText !== "")

            // If this server is either turning on or turning off then flag that
            // one of the servers is changing state...
            if (serverInfo.serverStatus === INSTANCE_PENDING || 
                serverInfo.serverStatus === INSTANCE_STOPPING) {
                    result.serverChangingState = true;
            } // End if            
        } // End if (blockID === LAST_CHECKED_BLOCK_ID)
    } // End of the for (let i = 0; i < blockCount; i++) loop.

    // Tell the calling function if any of the displayed servers are currently
    // changing state to on or off.
    return result;
}

// The original message is returned with a button click. From that we want the
// layout (e.g. 'layout 1') that's included in the Refresh button's value
function getLayoutFromMessage(message) {
    let layout = "";

    // Loop through the message blocks until we find the refresh button block
    // (the value on that button indicates which layout was used for the 
    // message)
    const blocks = message.blocks;
    const count = blocks.length;
    for (let i = 0; i < count; i++) {
        // If this is the refresh button block then grab the layout number from
        // the button's value and exit this loop.
        if (blocks[i].block_id === REFRESH_STATUSES_ID) {
            layout = blocks[i].accessory.value;
            break;
        }
    }

    return layout;
}


// Helper to temporarly change a button's text when the button is clicked on so
// that we can indicate processing until the action completes. I gave the block
// and button the same id in each section to make things easier.
function adjustButtonText(theMessageToPost, blockID, newText) {
    let curBlock = null;
    let originalText = "";

    // Loop through the message blocks looking for the one requested...
    const messageBlocks = theMessageToPost.blocks;
    const count = messageBlocks.length;
    for (let i = 0; i < count; i++) {
        curBlock = messageBlocks[i];
        if (curBlock.block_id === blockID) {
            // If the block type is a section, the button is in an accessory
            // (aligned to the right) then...
            if (curBlock.type === "section") {
                originalText = curBlock.accessory.text.text;
                curBlock.accessory.text.text = newText;
            }
            // If the block is an "actions" block (button is aligned to the
            // left) like the 'Flag in Use' button.
            else if (curBlock.type === "actions") {
                originalText = curBlock.elements[0].text.text;
                curBlock.elements[0].text.text = newText;
            } // End if

            // No need to keep looping. We found the block we wanted.
            break; 
        } // End if (curBlock.block_id === blockID)
    }

    return originalText;
}

// This function is called after the Turn On/Off buttons have finished updating
// the message so that the other messages are refreshed to reflect the recent
// changes. This function is also called by the scheduled tasks to refresh the
// messages with recent changes directly in AWS for example.
//
// Pass "" for layout if you want all messages refreshed. Otherwise, the
// layout specified is skipped assuming that it was already refreshed because of
// a change and the caller wants the other messages refreshed to reflect the
// change too.
async function refreshMessages(layout, channelId) {
    const ignoreKey = `${layout}:${channelId}`;
    let keyID = "";
    let itemData = null;

    // Get the list of all keys (IDs) that we have in storage and loop through
    // them...
    await storage.init();
    const keys = await storage.keys();
    const keyCount = keys.length;
    for (let i = 0; i < keyCount; i++) {
        // If the current key is a layout that we want to ignore then skip
        // to the next loop.
        keyID = keys[i];
        if (keyID === ignoreKey) { continue; }

        // Grab the message data for the current layout and have the message
        // refreshed
        itemData = await storage.getItem(keyID);
        setMessage(false, itemData.layout, itemData.channelId, itemData.ts);
    }
}


//----------------
// Refresh job - Once an hour, the messages are refreshed to make sure they're
//               displaying an accurate status (someone may have turned things
//               on/off in AWS directly for example)
// 
const hourlyJob = new schedule.scheduleJob("0 * * * *", async () => {
    // -1 because the layout/channel is not to be ignored (they're all to be
    // refreshed)
    refreshMessages("", "-1");
});
//----------------


//----------------
// Auto Shutdown job - At the end of each day, turn off the servers
const shutdownJob = schedule.scheduleJob({hour: 18, minute: 0, tz: 'America/Glace_Bay'}, 
    async () => {
        // Get the status of the servers
        const awsStatusResults = await getEC2InstanceStatuses(REGION_VIRGINIA, 
            [
                process.env.AWS_SERVER1_INSTANCE_ID,
                process.env.AWS_SERVER2_INSTANCE_ID
            ]);

        // Have any servers that are running, shut down. If any of the servers were shut 
        // down by this job then refresh all the messages (-1 because the layout/channel
        // is not to be ignored. they're all to be refreshed)
        if(await shutDownServerIfRunning(REGION_VIRGINIA, awsStatusResults)) {
            refreshMessages("", "-1");
        }
});

async function shutDownServerIfRunning(region, data) {
    let curInstance = null;
    let serverStopped = false;
    
    // Loop through the instances that we were given...
    const instanceStatuses = data.InstanceStatuses;
    const count = instanceStatuses.length;    
    for (let i = 0; i < count; i++) {
        // If the current server is starting up or on then...
        curInstance = instanceStatuses[i];
        if (curInstance.InstanceState.Code === INSTANCE_PENDING ||
            curInstance.InstanceState.Code === INSTANCE_RUNNING) {
                // Turn it off and flag that at least one server was stopped
                await stopEC2Instance(region, curInstance.InstanceId);
                serverStopped = true;
        }
    }

    // Tell the caller if any of the servers were turned off
    return serverStopped;
}
//----------------



app.error(async (error) => { console.error(error); });

// Start the app
(async () => {
    await app.start(process.env.PORT || 3003);
    console.log('⚡️ Bolt app is running!');
})();



// To listen for messages from Slack, in a different terminal, run: 
//      ngrok http 3003
//
// To install it: npm install ngrok -g

// Run this at the terminal: node app.js
