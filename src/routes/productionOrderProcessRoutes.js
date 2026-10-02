const express = require("express");

const {
    getProductionOrderProcesses,
    generateProductionOrderProcesses,
    startProductionProcess,
    completeProductionProcess
} = require("../controllers/productionOrderProcessController");

const router = express.Router();


// =====================================================
// GET PROCESS FLOW
// =====================================================

router.get(
    "/order/:orderId",
    getProductionOrderProcesses
);


// =====================================================
// GENERATE PROCESS FLOW
// =====================================================

router.post(
    "/order/:orderId/generate",
    generateProductionOrderProcesses
);


// =====================================================
// START PROCESS
// =====================================================

router.post(
    "/:id/start",
    startProductionProcess
);


// =====================================================
// COMPLETE PROCESS
// =====================================================

router.post(
    "/:id/complete",
    completeProductionProcess
);


module.exports = router;