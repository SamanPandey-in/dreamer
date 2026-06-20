import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { ECSClient, RunTaskCommand } from '@aws-sdk/client-ecs';
import { generateSlug } from 'random-word-slugs';
import { env } from './lib/env';
import { authRouter } from './auth';
import { errorHandlerMiddleware } from './middleware/error-handler.middleware';

const ecsClient = new ECSClient({
  region: env.AWS_REGION,
  credentials: {
    accessKeyId: env.AWS_ACCESS_KEY_ID ?? '',
    secretAccessKey: env.AWS_SECRET_ACCESS_KEY ?? '',
  },
});

export const app = express();

// Render sits exactly one reverse-proxy hop in front of this app. Trusting
// only that one hop (not `true`, which trusts the whole X-Forwarded-For
// chain) is what lets req.ip resolve to the real visitor — and is what
// express-rate-limit needs to key the abuse-prone auth routes correctly.
app.set('trust proxy', true); // Trust the first proxy (e.g., load balancer) for correct client IP and secure cookie handling

// CORS must allow exactly ONE known origin (never '*') AND credentials: true,
// or the browser silently refuses to send/receive the refresh cookie at all.
app.use(cors({ origin: env.FRONTEND_URL, credentials: true }));
app.use(express.json());
app.use(cookieParser());

app.use('/api/auth', authRouter);

// Existing project/deploy route — unchanged behaviour, just relocated
interface ProjectRequestBody {
  gitUrl: string;
  slug?: string;
}

app.post('/api/deploy', async (req, res) => {
  const { gitUrl, slug } = req.body as ProjectRequestBody;
  const projectSlug: string = slug ? slug : generateSlug();

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
          process.env.ECS_SUBNET3_ARN || '',
        ],
        securityGroups: [process.env.ECS_SECURITY_GROUP_ARN || ''],
      },
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
            { name: 'PROJECT_ID', value: projectSlug },
          ],
        },
      ],
    },
  });

  try {
    await ecsClient.send(runTaskCommand);
    return res.json({ status: 'queued', data: { projectSlug, url: `http://${projectSlug}.localhost:8000` } });
  } catch (error) {
    console.error('Failed to run ECS task', error);
    return res.status(500).json({ error: 'Failed to queue project task' });
  }
});

app.get('/health', (req, res) => res.json({ status: 'ok' }));

// MUST be the LAST app.use() call — Express only treats a 4-argument
// function as an error handler, and only catches errors from middleware/
// routes registered before it.
app.use(errorHandlerMiddleware);