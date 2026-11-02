/** All money values from the API are integer paise (₹1 = 100 paise). */

export type RestaurantStatus = 'pending' | 'approved' | 'rejected' | 'suspended';

export interface Address {
  line1: string;
  line2?: string;
  area?: string;
  city: string;
  state: string;
  postalCode: string;
}

export interface GeoPoint {
  type: 'Point';
  /** [longitude, latitude] */
  coordinates: [number, number];
}

export interface Restaurant {
  id: string;
  name: string;
  slug: string;
  description?: string;
  cuisines: string[];
  phone: string;
  email?: string;
  address: Address;
  location: GeoPoint;
  imageUrl?: string;
  isPureVeg: boolean;
  costForTwoPaise: number;
  minOrderPaise: number;
  avgPrepTimeMinutes: number;
  openingTime: string;
  closingTime: string;
  isAcceptingOrders: boolean;
  isOpenNow: boolean;
  status: RestaurantStatus;
  statusReason?: string;
  reviewedAt?: string;
  rating: { average: number; count: number };
  /** Straight-line distance, present only for nearby searches. */
  distanceMeters?: number;
  createdAt: string;
  updatedAt: string;
}

/** Restaurant as seen by admins (owner populated). */
export interface AdminRestaurant extends Restaurant {
  owner: { id?: string; _id?: string; name: string; email: string; phone?: string; status?: string };
}

export interface RestaurantInput {
  name: string;
  description?: string;
  cuisines: string[];
  phone: string;
  email?: string;
  address: Address;
  location: { latitude: number; longitude: number };
  imageUrl?: string;
  isPureVeg: boolean;
  costForTwoPaise: number;
  minOrderPaise: number;
  avgPrepTimeMinutes: number;
  openingTime: string;
  closingTime: string;
}

export interface MenuStats {
  totalItems: number;
  availableItems: number;
  categoriesUsed: number;
}

export interface FoodCategory {
  id: string;
  name: string;
  slug: string;
  description?: string;
  icon: string;
  imageUrl?: string;
  sortOrder: number;
  isActive: boolean;
  /** Admin list only. */
  itemCount?: number;
}

export type FoodCategoryInput = Partial<Pick<FoodCategory, 'name' | 'description' | 'icon' | 'imageUrl' | 'sortOrder' | 'isActive'>>;

export interface FoodItem {
  id: string;
  restaurant: string;
  category: Pick<FoodCategory, 'name' | 'slug' | 'icon'> & { id?: string; _id?: string };
  name: string;
  description?: string;
  pricePaise: number;
  isVeg: boolean;
  isAvailable: boolean;
  imageUrl?: string;
  prepTimeMinutes?: number;
  tags?: string[];
  createdAt: string;
  updatedAt: string;
}

export interface FoodItemInput {
  name: string;
  description?: string;
  category: string;
  pricePaise: number;
  isVeg: boolean;
  isAvailable?: boolean;
  imageUrl?: string;
  prepTimeMinutes?: number | null;
}

/** Restaurant summary embedded in dish search results. */
export interface DishRestaurantSummary {
  id: string;
  name: string;
  slug: string;
  cuisines: string[];
  rating: { average: number; count: number };
  imageUrl?: string;
  city?: string;
  avgPrepTimeMinutes: number;
  isOpenNow?: boolean;
}

export interface DishSearchResult extends Omit<FoodItem, 'restaurant' | 'category'> {
  restaurant: DishRestaurantSummary;
  /** null if the dish's category has since been removed. */
  category: FoodItem['category'] | null;
}

export interface MenuSection {
  category: Pick<FoodCategory, 'id' | 'name' | 'slug' | 'icon'> | null;
  items: FoodItem[];
}

export type RestaurantSort = 'rating' | 'fastest' | 'costLow' | 'costHigh' | 'newest' | 'distance';

export interface RestaurantQuery {
  search?: string;
  cuisine?: string;
  category?: string;
  veg?: boolean;
  sort?: RestaurantSort;
  lat?: number;
  lng?: number;
  radiusKm?: number;
  page?: number;
  limit?: number;
}

/** Category id → menu item category id helper (API populates `_id` or `id`). */
export const categoryIdOf = (item: Pick<FoodItem, 'category'>): string =>
  item.category.id ?? item.category._id ?? '';
