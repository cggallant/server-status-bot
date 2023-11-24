module.exports.messageTemplate_allServers = {
	"blocks": [
		{
			"type": "section",
			"block_id": "RefreshStatuses",
			"text": {
				"type": "mrkdwn",
				"text": "*Test Servers*"
			},
			"accessory": {
				"type": "button",
				"text": {
					"type": "plain_text",
					"text": ":repeat: Refresh"
				},
				"action_id": "RefreshStatuses",
				"value": "layout 1"
			}
		},
		{
			"type": "context",
			"block_id": "LastCheckedSummary",
			"elements": [
				{
					"type": "mrkdwn",
					"text": "Server statuses are checked hourly"
				}
			]
		},
		{
			"type": "section",
			"block_id": "TurnOnOff_Server1",
			"text": {
				"type": "mrkdwn",
				"text": "*Server 1*"
			},
			"accessory": {
				"type": "button",
				"text": {
					"type": "plain_text",
					"text": "Turn On"
				},
				"action_id": "TurnOnOff_Server1"
			}
		},
		{
			"type": "divider",
			"block_id": "Divider1"
		},
		{
			"type": "section",
			"block_id": "TurnOnOff_Server2",
			"text": {
				"type": "mrkdwn",
				"text": "*Server 2*"
			},
			"accessory": {
				"type": "button",
				"text": {
					"type": "plain_text",
					"text": "Turn On"
				},
				"action_id": "TurnOnOff_Server2"
			}
		}
	]
};