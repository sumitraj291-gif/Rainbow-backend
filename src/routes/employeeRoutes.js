const express = require("express");
const {
    getEmployees,
    getEmployeeStats,
    getEmployeeOptions,
    getEmployeeById,
    createEmployee,
    updateEmployee,
    deleteEmployee,
    seedSampleEmployees
} = require("../controllers/employeeController");

const router = express.Router();

router.get("/", getEmployees);
router.get("/stats", getEmployeeStats);
router.get("/options", getEmployeeOptions);
router.post("/seed", seedSampleEmployees);
router.get("/:id", getEmployeeById);
router.post("/", createEmployee);
router.put("/:id", updateEmployee);
router.delete("/:id", deleteEmployee);

module.exports = router;
