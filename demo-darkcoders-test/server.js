const express = require("express");
const path = require("path");
const { createBooksRouter } = require("./modules/books");
const { createOrdersRouter } = require("./modules/orders");

const app = express();
app.use(express.json());

const store = {
  books: [],
  orders: [],
  nextBookId: 1,
  nextOrderId: 1,
};

app.get("/openapi.json", (req, res) => {
  res.sendFile(path.join(__dirname, "openapi.json"));
});

app.get("/swagger.json", (req, res) => {
  res.sendFile(path.join(__dirname, "swagger.json"));
});

app.use("/api/books", createBooksRouter(store));
app.use("/api/orders", createOrdersRouter(store));

app.listen(4011, "127.0.0.1", () => {
  console.log("Listening on http://127.0.0.1:4011");
});
