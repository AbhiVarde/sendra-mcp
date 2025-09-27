require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { Client, Databases, Query, Sites } = require("node-appwrite");

const app = express();
const PORT = 3001;

app.use(cors());
app.use(express.json());

// Appwrite Client
const client = new Client();
client
  .setEndpoint(process.env.APPWRITE_ENDPOINT)
  .setProject(process.env.APPWRITE_PROJECT_ID)
  .setKey(process.env.APPWRITE_API_KEY);

const databases = new Databases(client);

// MCP Client
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
        "/Users/uniqual/Sites/Desktop/sendra/mcp-send-email/build/index.js",
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
initializeMCP().then((client) => {
  mcpClient = client;
});

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
        text: emailData.text || emailData.html.replace(/<[^>]+>/g, ""),
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

function decodeApiKey(encodedApiKey) {
  return Buffer.from(encodedApiKey, "base64").toString();
}

function generateFailureEmail(deployment, projectId, userEmail) {
  return {
    to: userEmail,
    subject: `Failed production deployment on project '${deployment.siteName}'`,
    html: `
<!DOCTYPE html>
<html>
  <body style="font-family: Arial; background-color: #fff; color: #111; margin: 0; padding: 24px;">
    <div style="max-width: 600px; margin: auto;">
      <p>Hi there,</p>
      <p>There was an error deploying <strong>${
        deployment.siteName
      }</strong> to production on <strong>${projectId}</strong>.</p>
      <ul>
        <li>Deployment ID: ${deployment.resourceId}</li>
        <li>Status: ${deployment.status}</li>
        <li>Build Duration: ${deployment.buildDuration}s</li>
        <li>Created: ${new Date(deployment.$createdAt).toLocaleString()}</li>
      </ul>
      <p>Please check your deployment logs and try again.</p>
      <hr>
      <p style="font-size: 12px; color: #666; text-align: center;">
        Automated notification from Sendra (Local Demo with MCP).
      </p>
    </div>
  </body>
</html>`,
  };
}

// Fetch deployments
app.post("/api/fetch-deployments", async (req, res) => {
  try {
    const { projectId, apiKey } = req.body;
    if (!projectId || !apiKey) {
      return res.status(400).json({
        success: false,
        error: "Missing required parameters: projectId and apiKey",
      });
    }

    const decodedApiKey = decodeApiKey(apiKey);
    const userClient = new Client();
    userClient
      .setEndpoint(process.env.APPWRITE_ENDPOINT)
      .setProject(projectId)
      .setKey(decodedApiKey);

    const sites = new Sites(userClient);
    const sitesResponse = await sites.list();
    let allDeployments = [];

    for (const site of sitesResponse.sites || []) {
      try {
        const deploymentsResponse = await sites.listDeployments(site.$id);
        const recentDeployments = (deploymentsResponse.deployments || [])
          .sort((a, b) => new Date(b.$createdAt) - new Date(a.$createdAt))
          .slice(0, 5);

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

    allDeployments.sort(
      (a, b) => new Date(b.$createdAt) - new Date(a.$createdAt)
    );

    const failedDeployments = allDeployments.filter(
      (d) => d.status === "failed"
    );

    let emailsSent = 0;
    if (failedDeployments.length > 0) {
      try {
        const userDoc = await databases.listDocuments(
          process.env.APPWRITE_DATABASE_ID,
          process.env.APPWRITE_COLLECTION_ID,
          [Query.equal("projectId", projectId)]
        );

        const userEmail = userDoc.documents[0]?.email;
        if (userEmail && mcpClient) {
          for (const deployment of failedDeployments) {
            try {
              const emailData = generateFailureEmail(
                deployment,
                projectId,
                userEmail
              );
              await sendEmailViaMCP(emailData);
              emailsSent++;
            } catch (emailError) {
              console.error("Email error:", emailError);
            }
          }
        }
      } catch (dbError) {
        console.error("Failed to fetch user email:", dbError);
      }
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

// Test email
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
      to,
      subject,
      html: `
        <div style="font-family: Arial, sans-serif; padding: 20px;">
          <h2>Test Email from Sendra</h2>
          <p>${message}</p>
          <hr>
          <p style="font-size: 12px; color: #666;">
            Test email sent via Resend MCP from Sendra local server.
          </p>
        </div>
      `,
    };
    await sendEmailViaMCP(emailData);
    return res.json({ success: true, message: "Test email sent successfully" });
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

// Root
app.get("/", (req, res) => {
  res.json({
    message: "Sendra Local MCP Server",
    version: "1.0.0",
    endpoints: [
      "GET /health",
      "POST /api/fetch-deployments",
      "POST /api/test-email",
    ],
  });
});

app.listen(PORT, () => {
  console.log(`🚀 Local Sendra server running on http://localhost:${PORT}`);
  console.log(
    `📧 MCP Email integration: ${mcpClient ? "Ready" : "Initializing..."}`
  );
});
