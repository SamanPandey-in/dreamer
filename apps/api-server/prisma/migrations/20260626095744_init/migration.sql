-- CreateEnum
CREATE TYPE "DeploymentStatus" AS ENUM ('QUEUED', 'BUILDING', 'UPLOADING', 'STARTING', 'RUNNING', 'SLEEPING', 'WAKING', 'STOPPED', 'FAILED', 'CANCELLED', 'ERROR');

-- CreateEnum
CREATE TYPE "DeploymentType" AS ENUM ('STATIC', 'DYNAMIC');

-- CreateEnum
CREATE TYPE "Framework" AS ENUM ('REACT_CRA', 'REACT_VITE', 'VUE', 'SVELTE', 'NEXT_STATIC', 'NEXT_SSR', 'EXPRESS', 'FASTIFY', 'HONO', 'STATIC_HTML', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "LogLevel" AS ENUM ('INFO', 'WARN', 'ERROR', 'DEBUG', 'SYSTEM');

-- CreateEnum
CREATE TYPE "WebhookEvent" AS ENUM ('PUSH', 'PULL_REQUEST', 'RELEASE');

-- CreateEnum
CREATE TYPE "EnvironmentTarget" AS ENUM ('PRODUCTION', 'PREVIEW', 'DEVELOPMENT');

-- CreateTable
CREATE TABLE "User" (
    "id" UUID NOT NULL,
    "email" VARCHAR(320) NOT NULL,
    "passwordHash" VARCHAR(255),
    "name" VARCHAR(255) NOT NULL,
    "avatarUrl" TEXT,
    "githubId" INTEGER,
    "githubUsername" VARCHAR(255),
    "githubToken" TEXT,
    "refreshTokenHash" TEXT,
    "emailVerified" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ NOT NULL,
    "lastLoginAt" TIMESTAMPTZ,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserSession" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "userAgent" VARCHAR(512),
    "ipAddress" VARCHAR(45),
    "expiresAt" TIMESTAMPTZ NOT NULL,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Project" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "slug" VARCHAR(63) NOT NULL,
    "description" VARCHAR(500),
    "repoUrl" VARCHAR(2048) NOT NULL,
    "repoFullName" VARCHAR(512),
    "defaultBranch" VARCHAR(255) NOT NULL DEFAULT 'main',
    "isPrivate" BOOLEAN NOT NULL DEFAULT false,
    "webhookId" INTEGER,
    "webhookSecret" TEXT,
    "autoDeployEnabled" BOOLEAN NOT NULL DEFAULT true,
    "buildCommand" VARCHAR(500),
    "installCommand" VARCHAR(500),
    "outputDirectory" VARCHAR(255),
    "rootDirectory" VARCHAR(255),
    "activeDeploymentId" UUID,
    "lastDeployedAt" TIMESTAMPTZ,
    "deletedAt" TIMESTAMPTZ,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "Project_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Deployment" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "slug" VARCHAR(63) NOT NULL,
    "status" "DeploymentStatus" NOT NULL DEFAULT 'QUEUED',
    "type" "DeploymentType",
    "framework" "Framework",
    "environment" "EnvironmentTarget" NOT NULL DEFAULT 'PRODUCTION',
    "branch" VARCHAR(255) NOT NULL DEFAULT 'main',
    "commitHash" VARCHAR(40),
    "commitMessage" VARCHAR(500),
    "commitAuthor" VARCHAR(255),
    "deployedById" UUID,
    "url" TEXT,
    "ecsTaskArn" TEXT,
    "ecsServiceArn" TEXT,
    "ecsTaskDefArn" TEXT,
    "ecrImageUri" TEXT,
    "albTargetGroupArn" TEXT,
    "albListenerRuleArn" TEXT,
    "s3Prefix" TEXT,
    "errorMessage" TEXT,
    "errorCode" VARCHAR(50),
    "errorStep" VARCHAR(50),
    "buildDurationMs" INTEGER,
    "uploadedFileCount" INTEGER,
    "imageSizeBytes" INTEGER,
    "lastRequestAt" TIMESTAMPTZ,
    "sleepCount" INTEGER NOT NULL DEFAULT 0,
    "totalSleepMs" BIGINT NOT NULL DEFAULT 0,
    "triggeredBy" TEXT NOT NULL DEFAULT 'manual',
    "webhookDeliveryId" UUID,
    "queuedAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "buildStartedAt" TIMESTAMPTZ,
    "buildFinishedAt" TIMESTAMPTZ,
    "deployedAt" TIMESTAMPTZ,
    "stoppedAt" TIMESTAMPTZ,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "Deployment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeploymentStateTransition" (
    "id" UUID NOT NULL,
    "deploymentId" UUID NOT NULL,
    "fromStatus" "DeploymentStatus",
    "toStatus" "DeploymentStatus" NOT NULL,
    "reason" VARCHAR(500),
    "triggeredBy" VARCHAR(100),
    "metadata" JSONB,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DeploymentStateTransition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeploymentLog" (
    "id" BIGSERIAL NOT NULL,
    "deploymentId" UUID NOT NULL,
    "level" "LogLevel" NOT NULL DEFAULT 'INFO',
    "message" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "source" VARCHAR(50),
    "timestamp" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DeploymentLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EnvVariable" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "key" VARCHAR(255) NOT NULL,
    "value" TEXT NOT NULL,
    "iv" VARCHAR(32) NOT NULL,
    "environments" "EnvironmentTarget"[] DEFAULT ARRAY['PRODUCTION', 'PREVIEW', 'DEVELOPMENT']::"EnvironmentTarget"[],
    "isSecret" BOOLEAN NOT NULL DEFAULT true,
    "description" VARCHAR(500),
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "EnvVariable_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeploymentEnvSnapshot" (
    "id" UUID NOT NULL,
    "deploymentId" UUID NOT NULL,
    "key" VARCHAR(255) NOT NULL,
    "value" TEXT NOT NULL,
    "iv" VARCHAR(32) NOT NULL,

    CONSTRAINT "DeploymentEnvSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CustomDomain" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "domain" VARCHAR(253) NOT NULL,
    "verificationToken" VARCHAR(64) NOT NULL,
    "verified" BOOLEAN NOT NULL DEFAULT false,
    "verifiedAt" TIMESTAMPTZ,
    "sslStatus" TEXT NOT NULL DEFAULT 'pending',
    "sslIssuedAt" TIMESTAMPTZ,
    "sslExpiresAt" TIMESTAMPTZ,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "CustomDomain_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebhookDelivery" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "githubDeliveryId" VARCHAR(255),
    "event" "WebhookEvent" NOT NULL,
    "branch" VARCHAR(255) NOT NULL,
    "commitHash" VARCHAR(40),
    "commitMessage" VARCHAR(500),
    "deploymentTriggered" BOOLEAN NOT NULL DEFAULT false,
    "deploymentId" UUID,
    "skipReason" VARCHAR(255),
    "rawPayload" JSONB,
    "receivedAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WebhookDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" BIGSERIAL NOT NULL,
    "userId" UUID,
    "action" VARCHAR(100) NOT NULL,
    "resourceType" VARCHAR(50),
    "resourceId" VARCHAR(36),
    "ipAddress" VARCHAR(45),
    "userAgent" VARCHAR(512),
    "metadata" JSONB,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "User_githubId_key" ON "User"("githubId");

-- CreateIndex
CREATE INDEX "User_email_idx" ON "User"("email");

-- CreateIndex
CREATE INDEX "User_githubId_idx" ON "User"("githubId");

-- CreateIndex
CREATE UNIQUE INDEX "UserSession_tokenHash_key" ON "UserSession"("tokenHash");

-- CreateIndex
CREATE INDEX "UserSession_userId_idx" ON "UserSession"("userId");

-- CreateIndex
CREATE INDEX "UserSession_expiresAt_idx" ON "UserSession"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "Project_slug_key" ON "Project"("slug");

-- CreateIndex
CREATE INDEX "Project_userId_deletedAt_idx" ON "Project"("userId", "deletedAt");

-- CreateIndex
CREATE INDEX "Project_slug_idx" ON "Project"("slug");

-- CreateIndex
CREATE INDEX "Project_repoFullName_idx" ON "Project"("repoFullName");

-- CreateIndex
CREATE UNIQUE INDEX "Deployment_slug_key" ON "Deployment"("slug");

-- CreateIndex
CREATE INDEX "Deployment_projectId_createdAt_idx" ON "Deployment"("projectId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "Deployment_status_idx" ON "Deployment"("status");

-- CreateIndex
CREATE INDEX "Deployment_slug_idx" ON "Deployment"("slug");

-- CreateIndex
CREATE INDEX "Deployment_ecsServiceArn_idx" ON "Deployment"("ecsServiceArn");

-- CreateIndex
CREATE INDEX "DeploymentStateTransition_deploymentId_createdAt_idx" ON "DeploymentStateTransition"("deploymentId", "createdAt");

-- CreateIndex
CREATE INDEX "DeploymentLog_deploymentId_sequence_idx" ON "DeploymentLog"("deploymentId", "sequence");

-- CreateIndex
CREATE INDEX "DeploymentLog_deploymentId_timestamp_idx" ON "DeploymentLog"("deploymentId", "timestamp");

-- CreateIndex
CREATE INDEX "EnvVariable_projectId_idx" ON "EnvVariable"("projectId");

-- CreateIndex
CREATE UNIQUE INDEX "EnvVariable_projectId_key_key" ON "EnvVariable"("projectId", "key");

-- CreateIndex
CREATE INDEX "DeploymentEnvSnapshot_deploymentId_idx" ON "DeploymentEnvSnapshot"("deploymentId");

-- CreateIndex
CREATE UNIQUE INDEX "CustomDomain_domain_key" ON "CustomDomain"("domain");

-- CreateIndex
CREATE INDEX "CustomDomain_projectId_idx" ON "CustomDomain"("projectId");

-- CreateIndex
CREATE INDEX "CustomDomain_domain_idx" ON "CustomDomain"("domain");

-- CreateIndex
CREATE INDEX "WebhookDelivery_projectId_receivedAt_idx" ON "WebhookDelivery"("projectId", "receivedAt" DESC);

-- CreateIndex
CREATE INDEX "AuditLog_userId_createdAt_idx" ON "AuditLog"("userId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "AuditLog_resourceType_resourceId_idx" ON "AuditLog"("resourceType", "resourceId");

-- CreateIndex
CREATE INDEX "AuditLog_createdAt_idx" ON "AuditLog"("createdAt");

-- AddForeignKey
ALTER TABLE "UserSession" ADD CONSTRAINT "UserSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Project" ADD CONSTRAINT "Project_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Deployment" ADD CONSTRAINT "Deployment_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Deployment" ADD CONSTRAINT "Deployment_deployedById_fkey" FOREIGN KEY ("deployedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeploymentStateTransition" ADD CONSTRAINT "DeploymentStateTransition_deploymentId_fkey" FOREIGN KEY ("deploymentId") REFERENCES "Deployment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeploymentLog" ADD CONSTRAINT "DeploymentLog_deploymentId_fkey" FOREIGN KEY ("deploymentId") REFERENCES "Deployment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EnvVariable" ADD CONSTRAINT "EnvVariable_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeploymentEnvSnapshot" ADD CONSTRAINT "DeploymentEnvSnapshot_deploymentId_fkey" FOREIGN KEY ("deploymentId") REFERENCES "Deployment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomDomain" ADD CONSTRAINT "CustomDomain_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebhookDelivery" ADD CONSTRAINT "WebhookDelivery_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
