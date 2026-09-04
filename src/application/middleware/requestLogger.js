export const requestLogger = (req, res, next) => {
  console.log(`📥 Worker ${process.pid} processou: ${req.method} ${req.path}`);
  next();
};
