import dotenv from 'dotenv';
dotenv.config();

import express, { Request, Response } from 'express';
import cors from 'cors';
import { generateSlug } from 'random-word-slugs';
import { ECSClient, RunTaskCommand } from '@aws-sdk/client-ecs';
import Redis from 'ioredis';
import { Server, Socket } from 'socket.io';

const PORT = process.env.PORT || 3000;
const app = express();

// AWS Client setup (TypeScript implicitly types this based on the SDK definition)
const ecsClient = new ECSClient({ 
    region: process.env.AWS_REGION,
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID || '',
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || ''
    }
});

const subscriber = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');

const io = new Server({ cors: { origin: '*' } });

io.on('connection', (socket: Socket) => {
    socket.on('subscribe', (channel: string) => {
        socket.join(channel);
        socket.emit('message', `Joined ${channel}`);
    });
});

io.listen(9002);
console.log('Socket Server 9002');

app.use(cors());
app.use(express.json());

// Interface defining what to expect in the HTTP POST request body
interface ProjectRequestBody {
    gitUrl: string;
    slug?: string;
}

app.post('/project', async (req: Request<{}, {}, ProjectRequestBody>, res: Response) => {
    const { gitUrl, slug } = req.body;
    const projectSlug: string = slug ? slug : generateSlug();

    // The RunTaskCommand structure is validated against the official AWS type declarations
    const runTaskCommand = new RunTaskCommand({
        cluster: process.env.ECS_CLUSTER_ARN,
        taskDefinition: process.env.ECS_TASK_DEFINITION_ARN,
        launchType: 'FARGATE',
        count: 1,
        startedBy: 'api-server',
        networkConfiguration: {
            awsvpcConfiguration: {
                assignPublicIp: 'ENABLED',
                subnets: [
                    process.env.ECS_SUBNET1_ARN || '', 
                    process.env.ECS_SUBNET2_ARN || '', 
                    process.env.ECS_SUBNET3_ARN || ''
                ],
                securityGroups: [process.env.ECS_SECURITY_GROUP_ARN || '']
            }
        },
        overrides: {
            containerOverrides: [
                {
                    name: process.env.TASK_DEFINITION_IMAGE_NAME,
                    environment: [
                        { name: 'AWS_ACCESS_KEY_ID', value: process.env.AWS_ACCESS_KEY_ID },
                        { name: 'AWS_SECRET_ACCESS_KEY', value: process.env.AWS_SECRET_ACCESS_KEY },
                        { name: 'AWS_REGION', value: process.env.AWS_REGION },
                        { name: 'REDIS_URL', value: process.env.REDIS_URL },
                        { name: 'GIT_REPOSITORY_URL', value: gitUrl },
                        { name: 'PROJECT_ID', value: projectSlug }
                    ]
                }
            ]
        }
    });

    try {
        await ecsClient.send(runTaskCommand);
        return res.json({ status: 'queued', data: { projectSlug, url: `http://${projectSlug}.localhost:8000` } });
    } catch (error) {
        console.error("Failed to run ECS task", error);
        return res.status(500).json({ error: "Failed to queue project task" });
    }
});

async function initRedisSubscribe(): Promise<void> {
    console.log('Subscribed to logs....');
    await subscriber.psubscribe('logs:*');
    subscriber.on('pmessage', (pattern: string, channel: string, message: string) => {
        io.to(channel).emit('message', message);
    });
}

initRedisSubscribe();

app.listen(PORT, () => {
    console.log(`API server is running on port ${PORT}`);
    console.log({
        cluster: process.env.ECS_CLUSTER_ARN,
        taskDef: process.env.ECS_TASK_DEFINITION_ARN,
        subnet1: process.env.ECS_SUBNET1_ARN,
        sg: process.env.ECS_SECURITY_GROUP_ARN
    });
});
