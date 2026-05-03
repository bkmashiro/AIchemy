// Simulate what the PATCH endpoint does
const stub = {
  id: "stub-abc",
  name: "test",
  tags: ["a30"],
  socket_id: "socket-123"
};

console.log("Original stub:", stub);

// This is what happens in PATCH
stub.tags = ["a30"];
console.log("After assignment:", stub);

// This is what the response does
const { socket_id, ...rest } = stub;
console.log("Response body (socket_id removed):", rest);
console.log("Tags in response:", rest.tags);
console.log("Tags is array?", Array.isArray(rest.tags));

// Check JSON serialization
const json = JSON.stringify(rest);
console.log("JSON.stringify result:", json);

const parsed = JSON.parse(json);
console.log("After JSON round-trip:", parsed);
console.log("Tags in parsed:", parsed.tags);
