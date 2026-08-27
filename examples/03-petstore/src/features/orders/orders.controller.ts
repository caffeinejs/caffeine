import {
  Authorize,
  Controller,
  Delete,
  ErrHTTPNotFound,
  Get,
  Params,
  Post,
  Schema,
  Status,
  $p,
} from "@caffeinejs/http";
import { APIGroup, Operation } from "@caffeinejs/openapi";
import { apiErrorSchema } from "../../util/errors/index.js";
import type { CreateOrderDTO } from "./order.js";
import { createOrderSchema, orderIdParamSchema, orderSchema } from "./order.js";
import { OrdersRepository } from "./orders.repository.js";

@APIGroup({ name: "Orders", description: "Place and track adoption orders." })
@Controller("/orders", [OrdersRepository])
export class OrdersController {
  constructor(private readonly orders: OrdersRepository) {}

  @Post("/")
  @Status(201)
  @Authorize()
  @Schema({
    body: createOrderSchema,
    response: { 201: orderSchema, 404: apiErrorSchema, 422: apiErrorSchema },
  })
  @Params([$p.body()])
  @Operation({
    operationId: "createOrder",
    summary: "Place an adoption order",
    responses: { 404: { description: "No pet exists with the given petId" } },
  })
  create(dto: CreateOrderDTO) {
    // A missing pet throws ErrPetNotFound (an ErrHTTPNotFound) → 404 { code, message } via the global handler.
    return this.orders.create(dto);
  }

  @Get("/:id")
  @Authorize()
  @Schema({
    params: orderIdParamSchema,
    response: { 200: orderSchema, 404: apiErrorSchema },
  })
  @Params([$p.param("id")])
  @Operation({ operationId: "getOrder", summary: "Get an order by ID" })
  async get(id: string) {
    const order = await this.orders.get(id);
    if (!order) {
      throw new ErrHTTPNotFound(
        `The requested order with ID "${id}" was not found`,
      );
    }
    return order;
  }

  @Delete("/:id")
  @Status(204)
  @Authorize()
  @Schema({ params: orderIdParamSchema })
  @Params([$p.param("id")])
  @Operation({ operationId: "deleteOrder", summary: "Cancel an order" })
  async remove(id: string) {
    await this.orders.remove(id);
  }
}
