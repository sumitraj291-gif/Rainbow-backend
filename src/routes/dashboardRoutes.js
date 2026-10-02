const express = require("express");
const { getDashboardOverview } = require("../controllers/dashboardController");

const router = express.Router();

router.get("/overview", getDashboardOverview);

module.exports = router;
