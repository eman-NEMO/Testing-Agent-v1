const express = require("express");
const { ISBN_PATTERN, isJsonObject, isMissing, requireString } = require("../lib/validate");

function createBooksRouter(store) {
  const router = express.Router();

  router.get("/", (req, res) => {
    return res.status(200).json(store.books.map(publicBook));
  });

  router.post("/", (req, res) => {
    const body = req.body;
    const titleError = requireString(body, "title");
    if (titleError) return res.status(400).json({ error: titleError });

    const authorError = requireString(body, "author");
    if (authorError) return res.status(400).json({ error: authorError });

    if (!isJsonObject(body) || !Object.prototype.hasOwnProperty.call(body, "isbn") || isMissing(body.isbn)) {
      return res.status(500).json({ error: "Internal Server Error" });
    }

    if (typeof body.isbn !== "string" || !ISBN_PATTERN.test(body.isbn)) {
      return res.status(400).json({ error: "isbn must be 13 digits" });
    }

    if (isMissing(body.price) || typeof body.price !== "number" || !Number.isFinite(body.price) || body.price < 0) {
      return res.status(400).json({ error: "price must be a number greater than or equal to 0" });
    }

    const book = {
      id: store.nextBookId++,
      title: body.title,
      author: body.author,
      isbn: body.isbn,
      price: body.price,
    };
    store.books.push(book);
    return res.status(201).json(publicBook(book));
  });

  router.get("/:id", (req, res) => {
    const book = findBook(store, req.params.id);
    if (!book) return res.status(404).json({ error: "Book not found" });
    return res.status(200).json(publicBook(book));
  });

  router.delete("/:id", (req, res) => {
    const id = parseId(req.params.id);
    if (id === null) return res.status(404).json({ error: "Book not found" });

    const index = store.books.findIndex((entry) => entry.id === id);
    if (index === -1) return res.status(404).json({ error: "Book not found" });

    const [book] = store.books.splice(index, 1);
    return res.status(200).json(publicBook(book));
  });

  return router;
}

function parseId(value) {
  const id = Number(value);
  return Number.isInteger(id) ? id : null;
}

function findBook(store, rawId) {
  const id = parseId(rawId);
  if (id === null) return null;
  return store.books.find((entry) => entry.id === id) || null;
}

function publicBook(book) {
  return { id: book.id, title: book.title, author: book.author, isbn: book.isbn, price: book.price };
}

module.exports = { createBooksRouter, findBook, publicBook };
