const express = require("express");
const {
    getInventorySummary,
    getKPIs,
    stockInRolls,
    createDispatch,
    getDispatches,
    getDispatchById,
    getLocations
} = require("../controllers/finishedGoodsController");

const router = express.Router();

// KPI Stats
router.get("/kpis", getKPIs);

// Root & Inventory breakdown
router.get("/", getInventorySummary);
router.get("/inventory", getInventorySummary);

// Warehouse locations
router.get("/locations", getLocations);

// Stock-in rolls into warehouse
router.post("/stock-in", stockInRolls);

// Dispatches list & create
router.get("/dispatches", getDispatches);
router.get("/dispatches/:id", getDispatchById);
router.post("/dispatches", createDispatch);

module.exports = router;
