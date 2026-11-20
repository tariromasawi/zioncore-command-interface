import { Router, type IRouter } from "express";
import healthRouter from "./health";
import commandRouter from "./command";

const router: IRouter = Router();

router.use(healthRouter);
router.use(commandRouter);
router.use((_req,res)=>{res.status(404).json({error:"API route not found."});});

export default router;
