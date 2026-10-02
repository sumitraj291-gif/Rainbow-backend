const express = require("express");
const {
    getStockTransactions,
    getWIPStatus,
    getProductionReport,
    getQualityReport,
    getInventoryReport
} = require("../controllers/inventoryController");

const router = express.Router();

router.get("/stock-transactions", getStockTransactions);
router.get("/wip", getWIPStatus);
router.get("/reports/production", getProductionReport);
router.get("/reports/quality", getQualityReport);
router.get("/reports/inventory", getInventoryReport);

module.exports = router;
