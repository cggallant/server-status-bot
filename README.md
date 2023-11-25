# slack-server-status-bot
A Slack bot that allows staff to turn test servers on/off as needed rather than letting them run non-stop.


# Environment variables needed:

    The names of the two channels to post to
    ```
    POST_TO_CHANNEL_DEFAULT="general"                                 
    POST_TO_CHANNEL_SERVER2="server-2"
    ```

    In Slack API: Basic Info, Signing Secret:
    ```SLACK_SIGNING_SECRET=""```

    In Slack API: OAuth & Permissions for what the bot can do:
        *app_mentions:read*
        *chat:write*

        then add to the workspace

    ```SLACK_BOT_TOKEN=""```

    AWS EC2 instance ids that will be adjusted:
    ```
    AWS_SERVER1_INSTANCE_ID=""
    AWS_SERVER2_INSTANCE_ID=""
    ```

    AWS Access Keys of a user with permission to those two servers
    ```
    AWS_ACCESS_KEY_ID=""
    AWS_SECRET_ACCESS_KEY=""
    ```

    In Slack API: Event subscription so bot can listen for app_mention

    ```<ngrok path>/slack/events```


    In Slack API: Interactivity & Shortcuts so the bot can listen for button clicks

    ```<ngrok path>/slack/events```

        don't forget to click Save Changes (not automatic like in OAuth & Permissions view)

# AWS policy for EC2 instances (Replace AccountNumber and InstanceID in the resource arn paths below)

{
    "Version": "2012-10-17",
    "Statement": [
        {
            "Sid": "DescribeInstances",
            "Effect": "Allow",
            "Action": "ec2:DescribeInstanceStatus",
            "Resource": "*"
        },
        {
            "Sid": "LimitEC2ActionsOnSpecificInstances",
            "Effect": "Allow",
            "Action": [
                "ec2:StartInstances",
                "ec2:StopInstances"
            ],
            "Resource": [
                "arn:aws:ec2:us-east-1:AccountNumber:instance/InstanceID",
                "arn:aws:ec2:us-east-1:AccountNumber:instance/InstanceID"
            ]
        }
    ]
}