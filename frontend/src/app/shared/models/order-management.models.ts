import { Pagination } from './api.models';
import { Order, OrderStatus, RiderCard, VehicleType } from './checkout.models';

/** Orders still in progress (the restaurant's board, the admin's "active" filter). */
export const ACTIVE_STATUSES: OrderStatus[] = ['pending', 'confirmed', 'preparing', 'ready_for_pickup', 'assigned', 'picked_up', 'on_the_way'];

export type OrderCounts = Partial<Record<OrderStatus, number>>;

/**
 * The restaurant's view of an order: no customer phone or exact address
 * (only name and area), plus whether a rider has accepted it.
 */
export interface RestaurantOrder extends Omit<Order, 'deliveryAddress' | 'rider'> {
  deliveryAddress: { recipientName: string; area?: string; city: string };
  riderAssigned: boolean;
}

export interface RestaurantActiveOrders {
  items: RestaurantOrder[];
  counts: OrderCounts;
}

export interface RestaurantOrderHistory {
  items: RestaurantOrder[];
  pagination: Pagination;
}

/** Status changes a restaurant may make. */
export type RestaurantAction = 'confirmed' | 'rejected' | 'preparing' | 'ready_for_pickup';

// ---------------------------------------------------------------------------
// Rider
// ---------------------------------------------------------------------------

export interface RiderProfile {
  id: string;
  vehicleType?: VehicleType;
  vehicleNumber?: string;
  isOnline: boolean;
  locationUpdatedAt?: string;
  completedDeliveries: number;
}

/**
 * An order as a rider sees it. Before they accept, the drop-off is only an
 * area (no phone, no exact address); `offerExpiresAt` is set on offers.
 */
export interface RiderOrder extends Omit<Order, 'deliveryAddress' | 'rider' | 'cancellation'> {
  deliveryAddress: Partial<Order['deliveryAddress']> & { location: { type: 'Point'; coordinates: [number, number] } };
  offerExpiresAt: string | null;
}

export interface RiderDashboard {
  profile: RiderProfile;
  offer: RiderOrder | null;
  activeOrder: RiderOrder | null;
}

export type RiderAction = 'picked_up' | 'on_the_way' | 'delivered';

// ---------------------------------------------------------------------------
// Admin
// ---------------------------------------------------------------------------

export interface AdminOrderList {
  items: Order[];
  pagination: Pagination;
  counts: OrderCounts;
}

export interface AdminOrder extends Order {
  /** The rider currently being offered the order (while ready for pickup). */
  offer: { rider: RiderCard | null; expiresAt: string } | null;
}

export interface AdminRider {
  id: string;
  name: string;
  email: string;
  phone?: string;
  status: 'active' | 'suspended';
  createdAt: string;
  vehicleType: VehicleType | null;
  vehicleNumber: string | null;
  isOnline: boolean;
  locationUpdatedAt: string | null;
  completedDeliveries: number;
  activeOrder: { id: string; orderNumber: string; status: OrderStatus } | null;
}
