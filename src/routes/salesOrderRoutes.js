const express = require("express");

const {
    getSalesOrders,
    getSalesOrderById,
    getSalesOrderOptions,
    createSalesOrder,
    updateSalesOrder,
    deleteSalesOrder,
    seedSalesOrders
} = require("../controllers/salesOrderController");

const router = express.Router();

router.get("/", getSalesOrders);
router.get("/options", getSalesOrderOptions);
router.post("/seed", seedSalesOrders);
router.get("/:id", getSalesOrderById);

router.post("/", createSalesOrder);
router.put("/:id", updateSalesOrder);
router.delete("/:id", deleteSalesOrder);

module.exports = router;