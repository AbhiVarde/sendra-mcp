require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { Client, Databases, Query, Sites } = require("node-appwrite");

const app = express();
const PORT = 3001;

// Middleware
app.use(cors());
app.use(express.json());

// Initialize Appwrite Client
const client = new Client();
client
  .setEndpoint(process.env.APPWRITE_ENDPOINT)
  .setProject(process.env.APPWRITE_PROJECT_ID)
  .setKey(process.env.APPWRITE_API_KEY);

const databases = new Databases(client);

// MCP Client Setup
async function initializeMCP() {
  try {
    const {
      Client: MCPClient,
    } = require("@modelcontextprotocol/sdk/client/index.js");
    const {
      StdioClientTransport,
    } = require("@modelcontextprotocol/sdk/client/stdio.js");

    const transport = new StdioClientTransport({
      command: "/Users/uniqual/.nvm/versions/node/v22.18.0/bin/node",
      args: [
        "/Users/uniqual/Sites/Desktop/sendra-mcp/mcp-send-email/build/index.js",
      ],
      env: {
        RESEND_API_KEY: process.env.RESEND_API_KEY,
        SENDER_EMAIL_ADDRESS: process.env.SENDER_EMAIL_ADDRESS,
      },
    });

    const mcpClient = new MCPClient(
      { name: "sendra-deployment-monitor", version: "1.0.0" },
      { capabilities: {} }
    );

    await mcpClient.connect(transport);
    console.log("Connected to Resend MCP server");

    return mcpClient;
  } catch (error) {
    console.error("Failed to initialize MCP client:", error);
    return null;
  }
}

let mcpClient = null;

// Initialize MCP on startup
initializeMCP().then((client) => {
  mcpClient = client;
});

// Function to send email via MCP
async function sendEmailViaMCP(emailData) {
  if (!mcpClient) {
    console.log("MCP client not initialized, skipping email");
    return;
  }

  try {
    const result = await mcpClient.callTool({
      name: "send-email",
      arguments: {
        to: emailData.to,
        subject: emailData.subject,
        text: emailData.text || emailData.html.replace(/<[^>]+>/g, ""), // plain text fallback
        html: emailData.html,
        from: process.env.SENDER_EMAIL_ADDRESS,
      },
    });

    console.log("Email sent via MCP:", result);
    return result;
  } catch (error) {
    console.error("Failed to send email via MCP:", error);
    throw error;
  }
}

// Function to decode API key
function decodeApiKey(encodedApiKey) {
  return Buffer.from(encodedApiKey, "base64").toString();
}

function buildConsoleUrl(projectId, siteId, region) {
  const regionCode = region || "fra";
  return `https://cloud.appwrite.io/console/project-${regionCode}-${projectId}/sites/site-${siteId}`;
}

// Generate email content for failed deployment
function generateFailureEmail(deployment, projectId, userEmail, region) {
  const consoleUrl = buildConsoleUrl(projectId, deployment.siteId, region);

  return {
    to: userEmail,
    subject: `Failed production deployment on project '${deployment.siteName}'`,
    html: `
<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Deployment Failed</title>
  </head>
  <body style="font-family: Arial, sans-serif; background-color: #fff; color: #111; margin: 0; padding: 24px;">
    <div style="max-width: 600px; margin: auto;">

      <p style="font-size: 15px; line-height: 1.5; margin: 0 0 16px 0;">
        Hi there,
      </p>

      <p style="font-size: 15px; line-height: 1.5; margin: 0 0 16px 0;">
        There was an error deploying <strong>${deployment.siteName}</strong> to the production environment 
        on <strong>your project</strong>.
      </p>

     <p style="font-size: 15px; line-height: 1.5; margin: 0 0 8px 0;">
        <a href="${consoleUrl}" 
           style="color: #2563eb; text-decoration: none;">See deployment details</a>
      </p>

      <p style="font-size: 15px; line-height: 1.5; margin: 0 0 24px 0;">
        You can also <a href="${consoleUrl}" 
        style="color: #2563eb; text-decoration: none;">view latest deployments</a> for branch 
        <strong>main</strong>.
      </p>

      <hr style="border: none; border-top: 1px solid #ddd; margin: 24px 0;">

      <p style="font-size: 12px; color: #666; margin: 0; text-align: center;">
        This is an automated notification from Sendra deployment monitoring system.
      </p>
    </div>
  </body>
</html>`,
  };
}

// Route to fetch deployments
app.post("/api/fetch-deployments", async (req, res) => {
  try {
    const { projectId, apiKey } = req.body;

    if (!projectId || !apiKey) {
      return res.status(400).json({
        success: false,
        error: "Missing required parameters: projectId and apiKey",
      });
    }

    console.log(`Fetching deployments for project: ${projectId}`);

    // Decode API key
    const decodedApiKey = decodeApiKey(apiKey);

    // Initialize Appwrite Client with user's credentials
    const userClient = new Client();
    userClient
      .setEndpoint(process.env.APPWRITE_ENDPOINT)
      .setProject(projectId)
      .setKey(decodedApiKey);

    const sites = new Sites(userClient);

    // Get sites and deployments
    const sitesResponse = await sites.list();
    let allDeployments = [];

    for (const site of sitesResponse.sites || []) {
      try {
        console.log(
          `Fetching deployments for site: ${site.$id} (${site.name})`
        );

        const deploymentsResponse = await sites.listDeployments(site.$id);
        console.log(
          `Found ${
            deploymentsResponse.deployments?.length || 0
          } deployments for site ${site.$id}`
        );

        const recentDeployments = (deploymentsResponse.deployments || [])
          .sort((a, b) => new Date(b.$createdAt) - new Date(a.$createdAt))
          .slice(0, 5); // only last 5 deployments

        const siteDeployments = recentDeployments.map((deployment) => ({
          siteId: site.$id,
          siteName: site.name,
          $id: deployment.$id,
          $createdAt: deployment.$createdAt,
          $updatedAt: deployment.$updatedAt,
          status: deployment.status,
          type: deployment.type || "",
          resourceId: deployment.resourceId || deployment.$id,
          sourceSize: deployment.sourceSize || 0,
          buildSize: deployment.buildSize || 0,
          totalSize: deployment.totalSize || 0,
          buildDuration: deployment.buildDuration || 0,
        }));

        allDeployments.push(...siteDeployments);
      } catch (depError) {
        console.log(
          `Failed to fetch deployments for site ${site.$id}: ${depError.message}`
        );
        continue;
      }
    }

    // Sort newest first
    allDeployments.sort(
      (a, b) => new Date(b.$createdAt) - new Date(a.$createdAt)
    );
    console.log(`Total deployments found: ${allDeployments.length}`);

    // Check for failed deployments and send emails via MCP
    const failedDeployments = allDeployments.filter(
      (d) => d.status === "failed"
    );

    let emailsSent = 0;

    if (failedDeployments.length > 0) {
      console.log(`🚨 Found ${failedDeployments.length} failed deployments!`);

      // Get user email from database
      try {
        const userDoc = await databases.listDocuments(
          process.env.APPWRITE_DATABASE_ID,
          process.env.APPWRITE_COLLECTION_ID,
          [Query.equal("projectId", projectId)]
        );

        const userEmail = userDoc.documents[0]?.email;
        const userRegion = userDoc.documents[0]?.region || "fra";
        console.log(`User email found: ${userEmail ? "Yes" : "No"}`);

        if (userEmail && mcpClient) {
          for (const deployment of failedDeployments) {
            try {
              console.log(
                `📧 Sending email for failed deployment: ${deployment.resourceId}`
              );
              const emailData = generateFailureEmail(
                deployment,
                projectId,
                userEmail,
                userRegion
              );
              await sendEmailViaMCP(emailData);
              emailsSent++;
              console.log(
                `✅ Email sent via MCP for deployment ${deployment.resourceId}`
              );
            } catch (emailError) {
              console.error(`❌ Failed to send email via MCP:`, emailError);
            }
          }
        } else {
          console.log("⚠️ MCP client not available or no user email found");
          console.log(
            `MCP client status: ${mcpClient ? "Connected" : "Not connected"}`
          );
        }
      } catch (dbError) {
        console.error("Failed to fetch user email from database:", dbError);
      }
    } else {
      console.log("✅ No failed deployments found");
    }

    return res.json({
      success: true,
      deployments: allDeployments,
      total: allDeployments.length,
      latestDeployment: allDeployments[0] || null,
      sitesCount: sitesResponse.sites?.length || 0,
      failedCount: failedDeployments.length,
      emailsSent: emailsSent,
    });
  } catch (error) {
    console.error("Local server error:", error);

    if (error.code === 401) {
      return res.status(401).json({
        success: false,
        error:
          "Invalid API key or insufficient permissions. Make sure your API key has 'sites.read' scope.",
      });
    }

    if (error.code === 404) {
      return res.status(404).json({
        success: false,
        error: "Project not found or no sites available.",
      });
    }

    return res.status(500).json({
      success: false,
      error: `Failed to fetch site deployments: ${error.message}`,
    });
  }
});

// Route to manually test email sending
app.post("/api/test-email", async (req, res) => {
  try {
    const { to, subject, message } = req.body;

    if (!to || !subject || !message) {
      return res.status(400).json({
        success: false,
        error: "Missing required fields: to, subject, message",
      });
    }

    if (!mcpClient) {
      return res.status(500).json({
        success: false,
        error: "MCP client not initialized",
      });
    }

    const emailData = {
      to: to,
      subject: subject,
      html: `
        <div style="font-family: Arial, sans-serif; padding: 20px;">
          <h2>Test Email from Sendra</h2>
          <p>${message}</p>
          <hr>
          <p style="font-size: 12px; color: #666;">
            This is a test email sent via Resend MCP from Sendra local development server.
          </p>
        </div>
      `,
    };

    await sendEmailViaMCP(emailData);

    return res.json({
      success: true,
      message: "Test email sent successfully",
    });
  } catch (error) {
    console.error("Test email error:", error);
    return res.status(500).json({
      success: false,
      error: `Failed to send test email: ${error.message}`,
    });
  }
});

// Health check
app.get("/health", (req, res) => {
  res.json({
    status: "Local Sendra server running with MCP",
    timestamp: new Date().toISOString(),
    mcpConnected: !!mcpClient,
    environment: {
      nodeVersion: process.version,
      port: PORT,
      hasResendKey: !!process.env.RESEND_API_KEY,
      hasSenderEmail: !!process.env.SENDER_EMAIL_ADDRESS,
    },
  });
});

// Root endpoint
app.get("/", (req, res) => {
  res.json({
    message: "Sendra Local MCP Server",
    version: "1.0.0",
    endpoints: [
      "GET /health - Health check",
      "POST /api/fetch-deployments - Fetch and monitor deployments",
      "POST /api/test-email - Send test email via MCP",
    ],
  });
});

app.listen(PORT, () => {
  console.log(
    `🚀 Local Sendra server with MCP running on http://localhost:${PORT}`
  );
  console.log(
    `📧 MCP Email integration: ${mcpClient ? "Ready" : "Initializing..."}`
  );
  console.log(`🔗 Health check: http://localhost:${PORT}/health`);
});
