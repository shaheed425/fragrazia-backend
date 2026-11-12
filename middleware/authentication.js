const jwt = require("jsonwebtoken");

const protect = (req, res, next) => {

  // header check
  if (!req.headers.authorization || !req.headers.authorization.startsWith("Bearer")) {
    return res.status(401).json({ message: "No Token" });
  }

  try {

    // token edukkuka
    const token = req.headers.authorization.split(" ")[1];
    console.log(token,"protect token");
    

    // verify
    const decoded = jwt.verify(token, process.env.SECRET_KEY);

    // user id save cheyyuka request il
    req.userId = decoded.id;

    next();

  } catch (error) {
    return res.status(401).json({ message: "Not Authorized" });
  }
};

module.exports = protect;