import * as categoryService from "../services/category.service.js";
import { sendSuccess } from "../utils/api-response.js";

export async function listActive(_req, res) {
  const categories = await categoryService.listActive();
  sendSuccess(res, { data: { categories: categories.map((c) => c.toJSON()) } });
}

export async function adminList(_req, res) {
  sendSuccess(res, { data: { categories: await categoryService.adminList() } });
}

export async function create(req, res) {
  const category = await categoryService.create(req.body);
  sendSuccess(res, { statusCode: 201, message: "Category created", data: { category: category.toJSON() } });
}

export async function update(req, res) {
  const category = await categoryService.update(req.params.id, req.body);
  sendSuccess(res, { message: "Category saved", data: { category: category.toJSON() } });
}

export async function remove(req, res) {
  await categoryService.remove(req.params.id);
  sendSuccess(res, { message: "Category deleted" });
}
