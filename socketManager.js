// Socket.io instance manager
// This module provides a way to share the socket.io instance across different modules

let io;

// Set the socket.io instance
function setIo(socketIo) {
  io = socketIo;
}

// Get the socket.io instance
function getIo() {
  if (!io) {
    throw new Error('Socket.io has not been initialized');
  }
  return io;
}

module.exports = {
  setIo,
  getIo
};