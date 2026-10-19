# test-design

Use this when the user names an area to test, such as users.

For each matching operation, suggest only cases the spec supports:

- A valid request, when a success status is documented and the path does not need an existing id.
- One missing-field case for each required field, when a validation status is documented.
- An invalid email, when the field format is email.
- A too-short value, when the spec gives a minimum length.
- A missing id, when the spec documents 404.

Show one case at a time, with its method, URL, and request body. Do not state an expected status. After the call, the user says whether the result matched. Ask for an existing id when a success call needs one, and for an existing email when a duplicate-email case would help. Nothing is sent until they approve the case on screen.
