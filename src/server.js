const express = require("express");
const cors = require("cors");
require("dotenv").config();

const pool = require("./config/database");
const { ensureDefaultAdminUser } = require("./config/bootstrap");

// ===============================
// ROUTES
// ===============================

const authRoutes = require("./routes/authRoutes");

const customerRoutes = require("./routes/customerRoutes");
const dashboardRoutes = require("./routes/dashboardRoutes");
const productionOrderRoutes = require("./routes/productionOrderRoutes");
const productRoutes = require("./routes/productRoutes");
const salesOrderRoutes = require("./routes/salesOrderRoutes");
const machineRoutes = require("./routes/machineRoutes");
const processRoutes = require("./routes/processRoutes");
const productionEntryRoutes = require("./routes/productionEntryRoutes");
const productRoutingRoutes = require("./routes/productRoutingRoutes");
const productionOrderProcessRoutes = require("./routes/productionOrderProcessRoutes");
const oeeRoutes = require("./routes/oeeRoutes");
const carpetRollRoutes = require("./routes/carpetRollRoutes");
const finishedGoodsRoutes = require("./routes/finishedGoodsRoutes");
const rollInspectionRoutes = require("./routes/rollInspectionRoutes");
const dispatchChallanRoutes = require("./routes/dispatchChallanRoutes");
const rawMaterialRoutes = require("./routes/rawMaterialRoutes");
const maintenanceRoutes = require("./routes/maintenanceRoutes");
const materialReceiptRoutes = require("./routes/materialReceiptRoutes");
const employeeRoutes = require("./routes/employeeRoutes");
const userRoutes = require("./routes/userRoutes");
const supplierRoutes = require("./routes/supplierRoutes");
const inventoryRoutes = require("./routes/inventoryRoutes");

// ===============================
// APP
// ===============================

const app = express();

// ===============================
// MIDDLEWARE
// ===============================

// CORS
app.use(cors());

// JSON request body
app.use(express.json());

// Form request body
app.use(express.urlencoded({ extended: true }));

// ===============================
// MAIN API
// ===============================

app.get("/", (req, res) => {
    res.json({
        success: true,
        message: "Production Management API is running"
    });
});

// ===============================
// DATABASE HEALTH
// ===============================

app.get("/api/health", async (req, res) => {
    try {
        const [rows] = await pool.query(
            "SELECT 1 AS database_connected"
        );

        res.json({
            success: true,
            message: "API and database connected successfully",
            database: rows[0].database_connected === 1
        });

    } catch (error) {
        console.error("Database Health Error:", error);

        res.status(500).json({
            success: false,
            message: "Database connection failed",
            error: error.message
        });
    }
});

// ===============================
// AUTHENTICATION
// ===============================

app.use("/api/auth", authRoutes);

// ===============================
// API ROUTES
// ===============================

app.use("/api/customers", customerRoutes);

app.use("/api/dashboard", dashboardRoutes);

app.use("/api/production-orders", productionOrderRoutes);

app.use("/api/products", productRoutes);

app.use("/api/sales-orders", salesOrderRoutes);

app.use("/api/machines", machineRoutes);

app.use("/api/processes", processRoutes);

app.use("/api/production-entries", productionEntryRoutes);

app.use(
    "/api/product-routing",
    productRoutingRoutes
);

app.use(
    "/api/production-order-processes",
    productionOrderProcessRoutes
);
app.use("/api/reports/oee", oeeRoutes);
app.use("/api/carpet-rolls", carpetRollRoutes);
app.use("/api/finished-goods", finishedGoodsRoutes);
app.use("/api/roll-inspections", rollInspectionRoutes);
app.use("/api/dispatches", dispatchChallanRoutes);
app.use("/api/raw-materials", rawMaterialRoutes);
app.use("/api/maintenance", maintenanceRoutes);
app.use("/api/material-receipts", materialReceiptRoutes);
app.use("/api/employees", employeeRoutes);
app.use("/api/users", userRoutes);
app.use("/api/suppliers", supplierRoutes);
app.use("/api/inventory", inventoryRoutes);

// ===============================
// SERVER
// ===============================

const PORT = process.env.PORT || 5000;

app.listen(PORT, async () => {
    console.log("----------------------------------------");
    console.log("Production Management API");
    console.log(`Server running on http://localhost:${PORT}`);
    console.log("----------------------------------------");

    await ensureDefaultAdminUser();
});