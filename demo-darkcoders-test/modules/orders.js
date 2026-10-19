const express = require("express");
const { EMAIL_PATTERN, isMissing, requireString } = require("../lib/validate");
const { findBook } = require("./books");

function createOrdersRouter(store) {
  const router = express.Router();

  router.get("/", (req, res) => {
    return res.status(200).json(store.orders.map(publicOrder));
  });

  router.post("/", (req, res) => {
    const body = req.body;
    const bookId = body && typeof body === "object" ? Number(body.bookId) : NaN;

    if (!Number.isInteger(bookId) || bookId < 1) {
      return res.status(400).json({ error: "bookId must be a positive integer" });
    }

    if (!findBook(store, bookId)) {
      return res.status(400).json({ error: "bookId must refer to an existing book" });
    }

    if (isMissing(body.quantity) || typeof body.quantity !== "number" || !Number.isInteger(body.quantity) || body.quantity < 1) {
      return res.status(400).json({ error: "quantity must be an integer of at least 1" });
    }

    const emailError = requireString(body, "customerEmail", { pattern: EMAIL_PATTERN, label: "customerEmail" });
    if (emailError === "customerEmail is invalid") {
      return res.status(400).json({ error: "customerEmail must be a valid email address" });
    }
    if (emailError) return res.status(400).json({ error: "customerEmail must be a valid email address" });

    const order = {
      id: store.nextOrderId++,
      bookId,
      quantity: body.quantity,
      customerEmail: body.customerEmail,
    };
    store.orders.push(order);
    return res.status(201).json(publicOrder(order));
  });

  router.get("/:id", (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(404).json({ error: "Order not found" });

    const order = store.orders.find((entry) => entry.id === id);
    if (!order) return res.status(404).json({ error: "Order not found" });
    return res.status(200).json(publicOrder(order));
  });

  return router;
}

function publicOrder(order) {
  return {
    id: order.id,
    bookId: order.bookId,
    quantity: order.quantity,
    customerEmail: order.customerEmail,
  };
}

module.exports = { createOrdersRouter };
