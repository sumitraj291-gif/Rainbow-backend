const express = require("express");

const {
    getProductionOrders,
    getProductionOrderById,
    getProductionOrderOptions,
    createProductionOrder,
    updateProductionOrder,
    deleteProductionOrder,
    seedProductionOrders
} = require("../controllers/productionOrderController");

const router = express.Router();

router.get("/", getProductionOrders);
router.get("/options", getProductionOrderOptions);
router.post("/seed", seedProductionOrders);
router.get("/:id", getProductionOrderById);


/*
CREATE
*/
router.post(
    "/",
    createProductionOrder
);


/*
UPDATE
*/
router.put(
    "/:id",
    updateProductionOrder
);


/*
DELETE
*/
router.delete(
    "/:id",
    deleteProductionOrder
);


module.exports = router;