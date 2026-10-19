# Requirements

No authentication secret is required. The API has two modules: books and orders. POST /api/books and POST /api/orders create data. GET /api/books, GET /api/books/{id}, GET /api/orders, and GET /api/orders/{id} are read-only. DELETE /api/books/{id} removes a book. An order must refer to a book that already exists.

1. GET /api/books — required fields: none. Expected status codes: 200.
2. POST /api/books — required fields: title (minLength 1), author (minLength 1), isbn (13 digits), price (number, minimum 0). Expected status codes: 201, 400.
3. GET /api/books/{id} — required fields: id (path). Expected status codes: 200, 404.
4. DELETE /api/books/{id} — required fields: id (path). Expected status codes: 200, 404.
5. GET /api/orders — required fields: none. Expected status codes: 200.
6. POST /api/orders — required fields: bookId (positive integer of an existing book), quantity (integer, minimum 1), customerEmail (format email). Expected status codes: 201, 400.
7. GET /api/orders/{id} — required fields: id (path). Expected status codes: 200, 404.
