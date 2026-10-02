const express = require("express");
const router = express.Router();
const maintenanceController = require("../controllers/maintenanceController");

// Stats & Machines
router.get("/stats", maintenanceController.getMaintenanceStats);
router.get("/machines", maintenanceController.getMachinesList);

// Breakdowns
router.get("/breakdowns", maintenanceController.getBreakdowns);
router.post("/breakdowns", maintenanceController.reportBreakdown);
router.put("/breakdowns/:id/resolve", maintenanceController.resolveBreakdown);

// Work Orders / PM
router.get("/work-orders", maintenanceController.getWorkOrders);
router.post("/work-orders", maintenanceController.createWorkOrder);
router.put("/work-orders/:id/complete", maintenanceController.completeWorkOrder);

module.exports = router;
