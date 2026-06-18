require('dotenv').config();

const express = require('express');
const { generateSlug } = require('random-word-slugs');
const { ECSClient, RunTaskCommand } = require('@aws-sdk/client-ecs');
const Redis = require('ioredis');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;
const app = express();

const ecsClient = new ECSClient({ 
    region: process.env.AWS_REGION,
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
    }
});

const subscriber = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');

const io = new Server({ cors: '*' })

io.on('connection', socket => {
    socket.on('subscribe', channel => {
        socket.join(channel)
        socket.emit('message', `Joined ${channel}`)
    })
})

io.listen(9002, () => console.log('Socket Server 9002'))

app.use(require('cors')());
app.use(express.json());

app.post('/project', async (req, res) => {
    const { gitUrl, slug } = req.body;
    const projectSlug = slug ? slug : generateSlug();

    const runTaskCommand = new RunTaskCommand({
        cluster: process.env.ECS_CLUSTER_ARN,
        taskDefinition: process.env.ECS_TASK_DEFINITION_ARN,
        launchType: 'FARGATE',
        count: 1,
        startedBy: 'api-server',
        networkConfiguration: {
            awsvpcConfiguration: {
                assignPublicIp: 'ENABLED',
                subnets: [process.env.ECS_SUBNET1_ARN, process.env.ECS_SUBNET2_ARN, process.env.ECS_SUBNET3_ARN],
                securityGroups: [process.env.ECS_SECURITY_GROUP_ARN]
            }
        },
        overrides: {
            containerOverrides: [
                {
                    name: process.env.TASK_DEFINITION_IMAGE_NAME,
                    environment: [
                        {
                            name: 'AWS_ACCESS_KEY_ID',
                            value: process.env.AWS_ACCESS_KEY_ID
                        },
                        {
                            name: 'AWS_SECRET_ACCESS_KEY',
                            value: process.env.AWS_SECRET_ACCESS_KEY
                        },
                        {
                            name: 'AWS_REGION',
                            value: process.env.AWS_REGION
                        },
                        {
                            name: 'REDIS_URL',
                            value: process.env.REDIS_URL
                        },
                        {
                            name: 'GIT_REPOSITORY_URL',
                            value: gitUrl
                        },
                        {
                            name: 'PROJECT_ID',
                            value: projectSlug
                        }
                    ]
                }
            ]
        }
    });

    await ecsClient.send(runTaskCommand)

    return res.json({ status: 'queued', data: { projectSlug, url: `http://${projectSlug}.localhost:8000` } });
});

async function initRedisSubscribe() {
    console.log('Subscribed to logs....')
    subscriber.psubscribe('logs:*')
    subscriber.on('pmessage', (pattern, channel, message) => {
        io.to(channel).emit('message', message)
    })
}

initRedisSubscribe()

app.listen(PORT, () => {
  console.log(`API server is running on port ${PORT}`);
  console.log({
  cluster: process.env.ECS_CLUSTER_ARN,
  taskDef: process.env.ECS_TASK_DEFINITION_ARN,
  subnet1: process.env.ECS_SUBNET1_ARN,
  sg: process.env.ECS_SECURITY_GROUP_ARN
});
});