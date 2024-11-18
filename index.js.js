const axios = require("axios");
const fs = require("fs").promises;
const express = require("express");
const app = express();
const moment = require("moment");
const mysql = require("mysql2");
const path = require("path");

// MySQL Database Configuration
const db = mysql.createConnection({
  host: "localhost", // Replace with your MySQL host
  user: "root", // Replace with your MySQL username
  password: "", // Replace with your MySQL password
  database: "csaraebackuponline", // Replace with your database name
});

// QuickBooks API Configuration
const baseUrl = "https://sandbox-quickbooks.api.intuit.com";
const companyId = "9341453270941131"; // Replace with your actual company ID
const clientId = "AB4aC7OI2XE01ATkKkdZbxV66zNF6eNPbURnv7su7vay2PtYsW"; // Replace with your actual Client ID
const clientSecret = "GfAdHm5fcehxEefwEpxfzuZk7CsTaC0sla4hbqxb"; // Replace with your actual Client Secret
const redirectUri = "http://localhost:3000/callback"; // Replace with your redirect URI

// Create the invoices table if it doesn't exist
const createTables = () => {
  const createInvoicesTableSQL = `
        CREATE TABLE IF NOT EXISTS invoices (
            id INT AUTO_INCREMENT PRIMARY KEY,
            project_id INT DEFAULT NULL,  -- Allow NULL values for project_id
            invoice_id VARCHAR(255) NOT NULL UNIQUE,
            customer_name VARCHAR(255) NOT NULL,
            customer_address TEXT NOT NULL, 
            invoice_date DATE NOT NULL,
            amount DECIMAL(10, 2) NOT NULL,
            balance DECIMAL(10, 2) NOT NULL,
            status VARCHAR(50) NOT NULL,
            description TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    `;

  db.query(createInvoicesTableSQL, (err, result) => {
    if (err) {
      console.error("Error creating invoices table:", err);
    } else {
      console.log("Invoices table is ready or already exists.");
    }
  });
};
app.use(express.json());
async function fetchInvoiceByNumber(accessToken, docNumber) {
  const query = `SELECT * FROM Invoice WHERE DocNumber = '${docNumber}'`;
  try {
    const response = await axios.get(
      `${baseUrl}/v3/company/${companyId}/query`,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        params: { query },
      }
    );
    if (response.data.QueryResponse && response.data.QueryResponse.Invoice) {
      return response.data.QueryResponse.Invoice[0];
    } else {
      console.log("Invoice not found.");
      return null;
    }
  } catch (error) {
    console.error("Error fetching invoice:", error);
    return null;
  }
}

// Update the invoice with new line item
async function updateInvoiceWithNewLine(accessToken, invoice) {
  try {
    const response = await axios.post(
      `${baseUrl}/v3/company/${companyId}/invoice`,
      invoice,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
      }
    );
    if (response.data) {
      console.log("\x1b[32m%s\x1b[0m", "Invoice updated successfully.");
      return true;
    } else {
      console.log("Failed to update the invoice.");
      return false;
    }
  } catch (error) {
    console.error("Error updating invoice:", error);
    return false;
  }
}

// Add new line item to an existing invoice by docNumber
app.post("/add-lines", async (req, res) => {
  const { docNumber, lines, serviceDate } = req.body;

  // Ensure all required fields are provided
  if (
    !docNumber ||
    !lines ||
    !Array.isArray(lines) ||
    lines.length === 0 ||
    !serviceDate
  ) {
    return res
      .status(400)
      .send("Missing required fields: docNumber, lines (array), serviceDate");
  }

  try {
    const tokens = await loadTokens();
    if (!tokens || !tokens.access_token) {
      return res
        .status(401)
        .send("No stored tokens found. Please authenticate first.");
    }

    const accessToken = tokens.access_token;
    const invoice = await fetchInvoiceByNumber(accessToken, docNumber);

    if (!invoice) {
      return res.status(404).send("Invoice not found.");
    }

    // Loop through the lines and add each one to the invoice
    for (const line of lines) {
      const { lineAmount, lineItemName, lineQty } = line;

      // Validate each line's data
      if (!lineAmount || !lineItemName || !lineQty) {
        return res
          .status(400)
          .send("Each line requires lineAmount, lineItemName, and lineQty");
      }

      // Create the line object for QuickBooks
      const newLine = {
        DetailType: "SalesItemLineDetail",
        Amount: lineAmount,
        Description: lineItemName,
        SalesItemLineDetail: {
          ServiceDate: moment(serviceDate).format("YYYY-MM-DD"),
          ItemRef: { name: lineItemName, value: "18" }, // Assuming "18" is the item ID
          Qty: lineQty,
          UnitPrice: lineAmount,
        },
      };

      invoice.Line.push(newLine);
    }

    // Update the invoice with the new lines
    const success = await updateInvoiceWithNewLine(accessToken, invoice);
    if (success) {
      res.send("New line items added and invoice updated successfully.");
    } else {
      res.status(500).send("Failed to update the invoice.");
    }
  } catch (error) {
    console.error("Error in /add-lines endpoint:", error);
    res.status(500).send("An error occurred while updating the invoice.");
  }
});

app.post("/create-invoice", async (req, res) => {
    const invoices = req.body; // Expecting an array of invoices
  
    // Validate incoming data
    if (!Array.isArray(invoices) || invoices.length === 0) {
      return res.status(400).send("An array of invoices is required");
    }
  
    const createdInvoicesPromises = invoices.map(async (invoice) => {
      const { itemName, itemValue, customerRef, qty, description, lines, dueDate } = invoice;
  
      // Validate each invoice
      if (!itemName || !itemValue || !customerRef || !qty || !description || !dueDate) {
        console.error("Validation Error:", {
          itemName,
          itemValue,
          customerRef,
          qty,
          description,
          dueDate
        });
        throw new Error("All fields are required for each invoice, including dueDate");
      }
  
      // Validate the dueDate format (should be YYYY-MM-DD)
      if (!moment(dueDate, "YYYY-MM-DD", true).isValid()) {
        console.error("Validation Error: Invalid dueDate format.");
        throw new Error("Invalid dueDate format. Use YYYY-MM-DD.");
      }
  
      // Validate the lines data
      if (!Array.isArray(lines) || lines.length === 0) {
        console.error("Validation Error: No invoice lines found.");
        throw new Error("Each invoice must have at least one line.");
      }
  
      // Create the lines for the invoice
      const invoiceLines = lines.map((line, index) => {
        const { lineItemName, lineAmount, lineQty, serviceDate } = line;
  
        // Validate that each line has required fields
        if (!lineItemName || !lineAmount || !lineQty || !serviceDate) {
          throw new Error("Each invoice line must have item name, amount, quantity, and service date.");
        }
  
        // Validate the serviceDate format (should be YYYY-MM-DD)
        if (!moment(serviceDate, "YYYY-MM-DD", true).isValid()) {
          throw new Error(`Invalid service date format for line ${index + 1}. Use YYYY-MM-DD.`);
        }
  
        return {
          DetailType: "SalesItemLineDetail",
          Amount: lineAmount,
          Description: lineItemName,
          SalesItemLineDetail: {
            ServiceDate: serviceDate, // Use the serviceDate from the request body
            ItemRef: {
              name: lineItemName,
              value: "18", // Use actual QuickBooks Item ID (assuming "18" is a placeholder)
            },
            Qty: lineQty,
            UnitPrice: lineAmount,
          },
        };
      });
  
      // Prepare the QuickBooks invoice data
      const newInvoice = {
        CustomerRef: {
          value: customerRef.toString(), // Replace with actual customer ID
        },
        Line: invoiceLines,
        TxnDate: moment().format("YYYY-MM-DD"), // Use the current date for the transaction date
        DueDate: dueDate, // Use dueDate from request body
      };
  
      try {
        // Call function to post the invoice to QuickBooks
        const response = await postInvoiceToQuickBooks(newInvoice);
        console.log("QuickBooks Response:", response.data);
        return response.data; // Return the created invoice response
      } catch (postError) {
        console.error("QuickBooks Post Error:", postError.message);
        throw new Error("Failed to post invoice to QuickBooks");
      }
    });
  
    try {
      // Wait for all invoice creation promises to resolve
      const createdInvoices = await Promise.all(createdInvoicesPromises);
      res.status(201).send(createdInvoices);
    } catch (error) {
      console.error("Error creating invoices:", error.message);
      return res.status(500).send("Error creating one or more invoices");
    }
});

  

// Function to get the invoice from QuickBooks using invoiceId
// Fetch the invoice using the provided invoice ID and company ID

// Function to update the invoice in QuickBooks with new

// Function to load tokens from the tokens.json file
const loadTokensFromDatabase = () => {
  return new Promise((resolve, reject) => {
    fs.readFile(path.join(__dirname, "tokens.json"), "utf8", (err, data) => {
      if (err) {
        reject(new Error("Error reading tokens from file"));
      }
      try {
        const tokens = JSON.parse(data);
        resolve(tokens);
      } catch (error) {
        reject(new Error("Error parsing tokens JSON"));
      }
    });
  });
};

// Function to post the invoice to QuickBooks
const postInvoiceToQuickBooks = async (inv) => {
  const realmId = "9341453270941131"; // Replace with your actual realm ID

  try {
    // Ensure that the access token is valid
    const accessToken = await getAccessToken(); // Ensure the token is valid and fresh

    if (!accessToken) {
      throw new Error("Failed to obtain a valid access token.");
    }

    // Post the invoice to QuickBooks
    const response = await axios.post(
      `https://sandbox-quickbooks.api.intuit.com/v3/company/${realmId}/invoice`,
      inv,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
      }
    );
    console.log("Invoice created successfully:", response.data);
    return response; // Return the response for further handling
  } catch (error) {
    console.error(
      "Error posting invoice to QuickBooks:",
      error.response ? error.response.data : error.message
    );
    throw new Error("QuickBooks API error"); // Throw error to be caught in the endpoint
  }
};

// Fetch invoices from QuickBooks API
// Fetch invoices from QuickBooks API and store them in MySQL
// Fetch invoices from QuickBooks API and store them in MySQL
const fetchInvoices = async (accessToken, realmId) => {
  try {
    // Ensure that the access token is valid
    const validAccessToken = await getAccessToken(); // Ensure the token is fresh

    if (!validAccessToken) {
      throw new Error("Failed to obtain a valid access token.");
    }

    const response = await axios.get(
      `https://sandbox-quickbooks.api.intuit.com/v3/company/${realmId}/query?query=select * from Invoice&minorversion=40`,
      {
        headers: {
          Authorization: `Bearer ${validAccessToken}`,
          Accept: "application/json",
          "Content-Type": "application/json",
        },
      }
    );

    console.log("Invoices fetched successfully:");

    const invoices = response.data.QueryResponse.Invoice || []; // Return an empty array if no invoices
    if (invoices.length > 0) {
      await storeInvoices(invoices); // Store fetched invoices in MySQL
    }

    // Get all invoices from MySQL
    const [allInvoices] = await db
      .promise()
      .query("SELECT invoice_id FROM invoices");

    // Extract invoice_ids from fetched invoices
    const fetchedInvoiceIds = invoices.map((invoice) => invoice.DocNumber);

    // Delete invoices in MySQL that are no longer in QuickBooks
    for (const invoice of allInvoices) {
      if (!fetchedInvoiceIds.includes(invoice.invoice_id)) {
        const deleteInvoiceSQL = "DELETE FROM invoices WHERE invoice_id = ?";
        await db.promise().query(deleteInvoiceSQL, [invoice.invoice_id]);
        console.log(
          `Deleted invoice ${invoice.invoice_id} from MySQL (no longer exists in QuickBooks).`
        );
      }
    }

    return invoices;
  } catch (error) {
    console.error("Error fetching invoices:", error);
    throw error;
  }
};

// Load tokens from tokens.json
async function loadTokens() {
  try {
    const tokens = JSON.parse(await fs.readFile("tokens.json", "utf-8"));
    return tokens;
  } catch (error) {
    console.error("Failed to load tokens:", error);
    return null; // Return null if tokens are not found
  }
}

// Save updated tokens to tokens.json
async function saveTokens(tokens) {
  try {
    await fs.writeFile("tokens.json", JSON.stringify(tokens, null, 2), "utf-8");
    console.log("Tokens saved successfully:", tokens); // Log the saved tokens
  } catch (error) {
    console.error("Failed to save tokens:", error);
  }
}

// Function to generate a random state
function generateState() {
  const state =
    Math.random().toString(36).substring(2, 15) +
    Math.random().toString(36).substring(2, 15); // Generates a random state string
  console.log("Generated state:", state); // Log the generated state
  return state;
}

// Generate the authorization URL with state
function getAuthorizationUrl() {
  const state = generateState(); // Generate a new state
  const url = `https://appcenter.intuit.com/connect/oauth2?client_id=${clientId}&redirect_uri=${redirectUri}&response_type=code&scope=com.intuit.quickbooks.accounting&state=${state}`;

  // Store the state in session or any other way you prefer, for validation later
  app.locals.state = state;

  console.log("Authorization URL:", url); // Log the authorization URL
  return url;
}
const processInvoiceCreation = async (invoiceData) => {
  try {
    const accessToken = await getAccessToken(); // Ensure access token is fresh
    const invoiceResponse = await postInvoiceToQuickBooks(
      invoiceData,
      accessToken
    );
    console.log("Invoice Created:", invoiceResponse.data);
  } catch (error) {
    console.error("Failed to create invoice:", error);
  }
};

// Authenticate and get the access token (with refresh token support)
async function getAccessToken() {
  const tokens = await loadTokens();

  if (tokens) {
    // Timestamp Log
    const utcTime = new Date(tokens.timestamp + tokens.expires_in * 1000);
    const istTime = moment(utcTime)
      .utcOffset(330)
      .format("YYYY-MM-DDTHH:mm:ss.SSS");
    console.log("Token Expiry Time (IST):", istTime); // Outputs token expiration in IST

    // Check if the access token is expired
    const expirationDate = new Date(
      tokens.timestamp + tokens.expires_in * 1000
    );
    const isExpired = expirationDate <= new Date();
    console.log("Token expired:", isExpired);

    if (!isExpired) {
      console.log("Access token is valid.");
      return tokens.access_token; // Return existing token if it's still valid
    }

    console.log("Access token expired, refreshing token...");
    // If expired, use the refresh token to get a new access token
    try {
      const response = await axios.post(
        "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer",
        new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: tokens.refresh_token,
        }).toString(),
        {
          headers: {
            Authorization: `Basic ${Buffer.from(
              `${clientId}:${clientSecret}`
            ).toString("base64")}`,
            "Content-Type": "application/x-www-form-urlencoded",
          },
        }
      );

      console.log("Refresh Token response:", response.data);

      const newTokens = {
        access_token: response.data.access_token,
        refresh_token: response.data.refresh_token || tokens.refresh_token,
        expires_in: response.data.expires_in,
        timestamp: Date.now(), // Save current time for expiration check
      };

      // Log the new tokens
      console.log("New Access Token:", newTokens.access_token);
      console.log("New Refresh Token:", newTokens.refresh_token);

      // Save the new tokens to tokens.json
      await saveTokens(newTokens);
      return newTokens.access_token;
    } catch (error) {
      console.error(
        "Error refreshing token:",
        error.response ? error.response.data : error.message
      );
      throw error;
    }
  } else {
    console.log("No tokens found. Please authorize the application.");
    return null;
  }
}
// Store the fetched invoices into MySQL database
const storeInvoices = async (invoices) => {
  for (const invoice of invoices) {
    const {
      Id: invoiceId,
      CustomerRef: customer,
      TxnDate: invoiceDate,
      Line,
      DocNumber: docNumber,
      Balance,
      TotalAmt,
      DueDate: dueDate,
    } = invoice;

    const customerName = customer ? customer.name : "Unknown";
    const customerAddress = invoice.BillAddr
      ? `${invoice.BillAddr.Line1}, ${invoice.BillAddr.City}, ${invoice.BillAddr.CountrySubDivisionCode} ${invoice.BillAddr.PostalCode}`
      : "No Address";
    const amount = TotalAmt || 0;

    // Determine the status based on amount and balance
    let status;
    if (Balance === 0) {
      status = "Paid";
    } else if (Balance === amount) {
      status = "Not Paid";
    } else {
      status = "Partially Paid";
    }

    // Extract description and unique project_ids with their service_dates
    const description = Line.map((line) => line.Description).join(", ");
    const projectDetails = [];

    Line.forEach((line) => {
      if (line.Description) {
        const match = line.Description.match(/Project #(\d+)/);
        if (match) {
          const projectId = parseInt(match[1], 10); // Extract project ID
          const serviceDate = line.SalesItemLineDetail
            ? line.SalesItemLineDetail.ServiceDate
            : null;

          // Ensure unique project_id entries with respective service dates
          if (!projectDetails.find((pd) => pd.projectId === projectId && pd.serviceDate === serviceDate)) {
            projectDetails.push({ projectId, serviceDate });
          }
        }
      }
    });

    // Insert the new invoice into the 'invoices' table if it doesn't already exist
    const checkInvoiceSQL = "SELECT COUNT(*) as count FROM invoices WHERE invoice_id = ?";
    const [results] = await db.promise().query(checkInvoiceSQL, [docNumber]);

    if (results[0].count === 0) {
      const insertInvoiceSQL = `INSERT INTO invoices (invoice_id, customer_name, customer_address, invoice_date, amount, balance, status, description, project_id, service_date, due_date)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
      await db.promise().query(insertInvoiceSQL, [
        docNumber,
        customerName,
        customerAddress,
        invoiceDate,
        amount,
        Balance,
        status,
        description,
        projectDetails[0]?.projectId || null, // Only the first projectId is stored in invoices
        projectDetails[0]?.serviceDate || null, // Only the first serviceDate is stored in invoices
        dueDate,
      ]);
      console.log(`New Invoice ${docNumber} stored successfully.`);
    }

    // Now, update the existing rows in the 'csa_finance_invoiced' table
    for (const { projectId, serviceDate } of projectDetails) {
      // Check if the project_id and service_date already exist in csa_finance_invoiced
      const checkProjectSQL = "SELECT project_id FROM csa_finance_invoiced WHERE project_id = ? AND service_date = ?";
      const [projectResults] = await db.promise().query(checkProjectSQL, [projectId, serviceDate]);

      if (projectResults.length > 0) {
        // If a matching project_id and service_date are found, update the row
        const updateProjectInvoiceSQL = `
                    UPDATE csa_finance_invoiced 
                    SET invoice_number = ?, due_date = ? 
                    WHERE project_id = ? AND service_date = ?`;
        await db.promise().query(updateProjectInvoiceSQL, [
          docNumber,
          dueDate,
          projectId,
          serviceDate,
        ]);
        console.log(`Invoice ${docNumber} linked to Project ${projectId} with Service Date ${serviceDate} updated.`);
      } else {
        console.log(`No matching Project ${projectId} with Service Date ${serviceDate} found for Invoice ${docNumber}. Skipping update.`);
      }
    }
  }

  // Update existing invoices that were not newly inserted
  for (const invoice of invoices) {
    const {
      CustomerRef: customer,
      TxnDate: invoiceDate,
      Line,
      DocNumber: docNumber,
      Balance,
      TotalAmt,
      DueDate: dueDate,
    } = invoice;

    const customerName = customer ? customer.name : "Unknown";
    const customerAddress = invoice.BillAddr
      ? `${invoice.BillAddr.Line1}, ${invoice.BillAddr.City}, ${invoice.BillAddr.CountrySubDivisionCode} ${invoice.BillAddr.PostalCode}`
      : "No Address";
    const amount = TotalAmt || 0;

    // Determine the status based on amount and balance
    let status;
    if (Balance === 0) {
      status = "Paid";
    } else if (Balance === amount) {
      status = "Not Paid";
    } else {
      status = "Partially Paid";
    }

    const description = Line.map((line) => line.Description).join(", ");
    const projectDetails = [];

    Line.forEach((line) => {
      if (line.Description) {
        const match = line.Description.match(/Project #(\d+)/);
        if (match) {
          const projectId = parseInt(match[1], 10);
          const serviceDate = line.SalesItemLineDetail
            ? line.SalesItemLineDetail.ServiceDate
            : null;

          if (!projectDetails.find((pd) => pd.projectId === projectId && pd.serviceDate === serviceDate)) {
            projectDetails.push({ projectId, serviceDate });
          }
        }
      }
    });

    const checkInvoiceSQL = "SELECT COUNT(*) as count FROM invoices WHERE invoice_id = ?";
    const [results] = await db.promise().query(checkInvoiceSQL, [docNumber]);

    if (results[0].count > 0) {
      const updateInvoiceSQL = `UPDATE invoices SET 
                customer_name = ?, 
                customer_address = ?, 
                invoice_date = ?, 
                amount = ?, 
                balance = ?, 
                status = ?, 
                description = ?, 
                project_id = ?, 
                service_date = ?, 
                due_date = ? 
                WHERE invoice_id = ?`;
      await db.promise().query(updateInvoiceSQL, [
        customerName,
        customerAddress,
        invoiceDate,
        amount,
        Balance,
        status,
        description,
        projectDetails[0]?.projectId || null,
        projectDetails[0]?.serviceDate || null,
        dueDate,
        docNumber,
      ]);
      console.log(`Existing Invoice ${docNumber} updated successfully.`);
    }
  }
};



// Function to create an invoice with multiple products

// Start the Express app to handle the callback
// Start the Express app to handle the callback
app.get("/callback", async (req, res) => {
  const { code, state } = req.query;

  // Log incoming state for debugging
  console.log("State received in callback:", state);
  console.log("Stored state:", app.locals.state);

  // Validate the state to protect against CSRF attacks
  if (state !== app.locals.state) {
    return res.status(400).send("State mismatch. Possible CSRF attack.");
  }

  if (!code) {
    return res.status(400).send("Authorization code is missing");
  }

  try {
    const response = await axios.post(
      "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer",
      new URLSearchParams({
        grant_type: "authorization_code",
        code: code,
        redirect_uri: redirectUri,
      }).toString(),
      {
        headers: {
          Authorization: `Basic ${Buffer.from(
            `${clientId}:${clientSecret}`
          ).toString("base64")}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
      }
    );

    console.log("Token exchange response:", response.data);

    const tokens = {
      access_token: response.data.access_token,
      refresh_token: response.data.refresh_token,
      expires_in: response.data.expires_in,
      timestamp: Date.now(),
    };

    await saveTokens(tokens);
    res.send("Authentication successful! You can now close this window.");

    // Fetch invoices after successful authentication and store them in MySQL
    const accessToken = tokens.access_token;
    const realmId = "9341453270941131"; // Replace with actual Realm ID
    await fetchInvoices(accessToken, realmId); // Fetch and store invoices
  } catch (error) {
    console.error(
      "Error during token exchange:",
      error.response ? error.response.data : error.message
    );
    res.status(500).send("Authentication failed.");
  }
});

app.listen(3000, async () => {
  // Connect to MySQL
  db.connect((err) => {
    if (err) {
      console.error("Error connecting to MySQL:", err);
      return;
    }
    console.log("Connected to MySQL database.");
    createTables(); // Ensure that tables are created
  });

  // Fetch tokens if available
  const tokens = await loadTokens();

  if (tokens && tokens.access_token) {
    console.log("Server started on http://localhost:3000");
    console.log("Using existing token...");

    // If the token is already available, set up the periodic fetch
    const accessToken = tokens.access_token;
    const realmId = "9341453270941131"; // Replace with actual Realm ID

    // Set up an interval to fetch invoices every 2 seconds
    setInterval(async () => {
      try {
        console.log("Fetching invoices...");
        await fetchInvoices(accessToken, realmId); // Fetch and store invoices
        console.log("Invoices fetched and stored successfully!");
      } catch (error) {
        console.error("Error fetching invoices:", error);
      }
    }, 2000); // 2000 ms = 2 seconds
  } else {
    console.log("Server started on http://localhost:3000");
    console.log(
      "Please authorize the application by visiting the following URL:"
    );
    console.log(getAuthorizationUrl());

    // If no tokens, you can fetch invoices after authentication (callback will handle this)
  }
});
