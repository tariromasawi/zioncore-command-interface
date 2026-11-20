import express, { type ErrorRequestHandler, type Express } from "express";
import cors from "cors";
import { resolve } from "node:path";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger, requestLogUrl } from "./lib/logger";

const app: Express = express();

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: requestLogUrl(req.url),
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
app.disable("x-powered-by");
app.use((_req,res,next)=>{
  res.set({"X-Content-Type-Options":"nosniff","Referrer-Policy":"strict-origin-when-cross-origin"});
  next();
});
app.use("/api/command/feed",cors({
  origin:["https://tariromasawi.github.io"],methods:["GET","HEAD"],
}));
app.use("/api/command/suggestions",cors({
  origin:["https://tariromasawi.github.io"],methods:["POST"],allowedHeaders:["Content-Type"],
}));
app.use(express.json({limit:"8kb"}));

app.use("/api", router);
if (process.env["COMMAND_WEB_DIR"]) {
  const web=resolve(process.env["COMMAND_WEB_DIR"]);
  app.use(express.static(web,{dotfiles:"deny"}));
  app.get(["/","/command.html","/engines/:id","/research","/knowledge","/runs","/runs/:id","/genesis","/continuity"],(_req,res)=>res.sendFile(resolve(web,"index.html")));
}

const hideError: ErrorRequestHandler=(error,_req,res,next)=>{
  if (res.headersSent) {next(error);return;}
  const status=error?.status===413?413:error?.status===400?400:500;
  res.status(status).json({error:status===413?"Request is too large.":status===400?"Invalid request.":"Request could not be completed."});
};
app.use(hideError);

export default app;
