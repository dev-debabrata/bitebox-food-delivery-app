/** Envelope returned by every BiteBox API endpoint. */
export interface ApiResponse<T> {
  success: true;
  message: string;
  data: T;
}

export interface ApiFieldError {
  field: string;
  message: string;
}

export interface ApiErrorBody {
  success: false;
  message: string;
  error?: { code?: string; details?: ApiFieldError[] };
}

export interface Pagination {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

export interface Paginated<T> {
  items: T[];
  pagination: Pagination;
}
