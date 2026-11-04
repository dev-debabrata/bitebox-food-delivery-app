import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { of, throwError } from 'rxjs';
import { HttpErrorResponse } from '@angular/common/http';
import { CatalogService } from '../../../core/services/catalog.service';
import { ReviewService } from '../../../core/services/review.service';
import { FoodItem, MenuSection, Restaurant } from '../../../shared/models/catalog.models';
import { RestaurantDetail } from './restaurant-detail';

const restaurant = {
  id: 'r1',
  name: 'Spice Route Kitchen',
  slug: 'spice-route-kitchen',
  cuisines: ['Biryani'],
  address: { line1: '12 Road', city: 'Bengaluru', state: 'KA', postalCode: '560038' },
  location: { type: 'Point', coordinates: [77.64, 12.97] },
  isPureVeg: false,
  costForTwoPaise: 50000,
  minOrderPaise: 0,
  avgPrepTimeMinutes: 25,
  openingTime: '10:00',
  closingTime: '23:00',
  isAcceptingOrders: true,
  isOpenNow: true,
  status: 'approved',
  rating: { average: 0, count: 0 },
} as unknown as Restaurant;

const dish = (name: string, isVeg: boolean, isAvailable = true) =>
  ({ id: name, name, isVeg, isAvailable, pricePaise: 10000, category: { name: 'Biryani', slug: 'biryani', icon: 'rice_bowl' } }) as unknown as FoodItem;

const sections: MenuSection[] = [
  { category: { id: 'c1', name: 'Biryani', slug: 'biryani', icon: 'rice_bowl' }, items: [dish('Chicken Biryani', false), dish('Veg Biryani', true)] },
  { category: { id: 'c2', name: 'Desserts', slug: 'desserts', icon: 'icecream' }, items: [dish('Kulfi', true, false)] },
];

describe('RestaurantDetail', () => {
  let fixture: ComponentFixture<RestaurantDetail>;
  const catalog = { restaurant: vi.fn(), menu: vi.fn() };
  const reviews = {
    restaurantReviews: vi.fn(() =>
      of({
        items: [],
        pagination: { page: 1, limit: 5, total: 0, totalPages: 0 },
        summary: { average: 0, count: 0, distribution: [0, 0, 0, 0, 0] },
      }),
    ),
  };

  async function create() {
    await TestBed.configureTestingModule({
      imports: [RestaurantDetail],
      providers: [
        provideRouter([]),
        { provide: CatalogService, useValue: catalog },
        { provide: ReviewService, useValue: reviews },
      ],
    }).compileComponents();
    fixture = TestBed.createComponent(RestaurantDetail);
    fixture.componentRef.setInput('slug', 'spice-route-kitchen');
    await fixture.whenStable();
    return fixture.nativeElement as HTMLElement;
  }

  beforeEach(() => {
    catalog.restaurant.mockReset().mockReturnValue(of(restaurant));
    catalog.menu.mockReset().mockReturnValue(of(sections));
  });

  it('renders the restaurant and its menu sections, flagging unavailable dishes', async () => {
    const el = await create();
    expect(el.querySelector('h1')?.textContent).toContain('Spice Route Kitchen');
    expect(el.querySelectorAll('.menu-section').length).toBe(2);
    expect(el.textContent).toContain('Unavailable');
  });

  it('filters to veg dishes and drops empty sections', async () => {
    const el = await create();
    const toggle = el.querySelector<HTMLInputElement>('.menu-tools np-toggle input[role=switch]')!;
    toggle.click();
    await fixture.whenStable();
    // Strip the veg badge's screen-reader label ("Vegetarian") from each name.
    const names = Array.from(el.querySelectorAll('.dish-name')).map((n) => n.textContent?.replace(/^\s*(Non-)?vegetarian/i, '').trim());
    expect(names).toEqual(['Veg Biryani', 'Kulfi']);
  });

  it('searches within the menu', async () => {
    const el = await create();
    const input = el.querySelector<HTMLInputElement>('.menu-search input')!;
    input.value = 'kulfi';
    input.dispatchEvent(new Event('input'));
    await fixture.whenStable();
    expect(el.querySelectorAll('.menu-section').length).toBe(1);
    expect(el.querySelector('.dish-name')?.textContent).toContain('Kulfi');
  });

  it('shows a not-found state for unknown or unapproved restaurants', async () => {
    catalog.restaurant.mockReturnValue(throwError(() => new HttpErrorResponse({ status: 404 })));
    const el = await create();
    expect(el.textContent).toContain('Restaurant not found');
  });
});
