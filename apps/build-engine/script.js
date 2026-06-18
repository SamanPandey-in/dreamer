const { exec } = require('child_process')
const path = require('path')
const fs = require('fs')
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3')
const mime = require('mime-types')
const Redis = require('ioredis')

const publisher = new Redis(process.env.REDIS_URL || 'redis://localhost:6379')

const s3Client = new S3Client({
    region: process.env.AWS_REGION || 'ap-south-1',
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
    }
})

const PROJECT_ID = process.env.PROJECT_ID

function publishLog(log) {
    publisher.publish(`logs:${PROJECT_ID}`, JSON.stringify({ log }))
}

// Helper function to run the build sequentially
function runBuildCommand(dirPath) {
    return new Promise((resolve, reject) => {
        const p = exec(`cd ${dirPath} && npm install && npm run build`)

        p.stdout.on('data', function (data) {
            console.log(data.toString())
            publishLog(data.toString())
        })

        // Capture stderr logs from the build command safely
        p.stderr.on('data', function (data) {
            console.error(data.toString())
            publishLog(`stderr: ${data.toString()}`)
        })

        p.on('close', function (code) {
            if (code === 0) {
                resolve()
            } else {
                reject(new Error(`Build process exited with code ${code}`))
            }
        })
    })
}

async function init() {
    console.log('Executing script.js')
    publishLog('Build Started...')
    const outDirPath = path.join(__dirname, 'output')

    try {
        // 1. Wait for the build to completely finish
        await runBuildCommand(outDirPath)
        
        console.log('Build Complete')
        publishLog(`Build Complete`)

        const distFolderPath = path.join(__dirname, 'output', 'dist')
        
        // Safety check to ensure the framework actually built a 'dist' folder
        if (!fs.existsSync(distFolderPath)) {
            throw new Error(`Build finished but configuration directory 'dist' was not found at ${distFolderPath}`)
        }

        const distFolderContents = fs.readdirSync(distFolderPath, { recursive: true })

        publishLog(`Starting to upload`)
        for (const file of distFolderContents) {
            const filePath = path.join(distFolderPath, file)
            if (fs.lstatSync(filePath).isDirectory()) continue;

            console.log('uploading', filePath)
            publishLog(`uploading ${file}`)

            const command = new PutObjectCommand({
                Bucket: 'dreamer-outputs',
                Key: `__outputs/${PROJECT_ID}/${file}`,
                Body: fs.createReadStream(filePath),
                ContentType: mime.lookup(filePath) || 'application/octet-stream'
            })

            await s3Client.send(command)
            publishLog(`uploaded ${file}`)
            console.log('uploaded', filePath)
        }
        publishLog(`Done`)
        console.log('Done...')

    } catch (error) {
        console.error('Fatal execution error:', error.message)
        publishLog(`Fatal Error: ${error.message}`)
        process.exit(1)
    }
}

init()
