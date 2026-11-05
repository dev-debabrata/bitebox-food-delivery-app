import { environment } from '../../../../environments/environment';

/** A footer link: an app route (with optional query/fragment) or an external URL. */
export interface FooterLink {
  label: string;
  /** App route. `null` = the page does not exist yet; the link is not shown until it does. */
  route?: string | null;
  queryParams?: Record<string, string>;
  fragment?: string;
  /** External URL (opens in a new tab). Empty = not configured; not shown. */
  href?: string;
  icon?: string;
  /** Only for signed-out visitors (e.g. partner sign-up, hidden on the home page once signed in). */
  visitorsOnly?: boolean;
}

/** A page BiteBox does not have yet: listed so it is easy to switch on, never shown until then. */
const soon = (label: string): FooterLink => ({ label, route: null });

export interface FooterGroup {
  title: string;
  links: FooterLink[];
}

/**
 * Footer navigation. Every route below exists. Entries with `route: null` are pages BiteBox
 * does not have yet (about, careers, blog, FAQ, policies); give them a route once the page is
 * built and they appear automatically. Do not point them anywhere else in the meantime.
 */
export const FOOTER_GROUPS: FooterGroup[] = [
  {
    title: 'Company',
    links: [
      soon('About us'),
      soon('Our story'),
      soon('Careers'),
      soon('Blog'),
      { label: 'Contact us', route: '/support' },
      { label: 'Partner with us', route: '/', fragment: 'partners', visitorsOnly: true },
    ],
  },
  {
    title: 'Explore BiteBox',
    links: [
      { label: 'Browse restaurants', route: '/restaurants' },
      { label: 'Top-rated restaurants', route: '/restaurants', queryParams: { sort: 'rating' } },
      { label: 'Offers & rewards', route: '/account/rewards' },
      { label: 'Refer & earn', route: '/account/refer' },
      { label: 'My orders & tracking', route: '/orders' },
    ],
  },
  {
    title: 'Customer support',
    links: [
      { label: 'Help center', route: '/support' },
      soon('Frequently asked questions'),
      soon('Cancellation policy'),
      soon('Refund policy'),
    ],
  },
  {
    title: 'Legal & policies',
    links: [
      soon('Terms & conditions'),
      soon('Privacy policy'),
      soon('Cookie policy'),
      soon('Refund & cancellation policy'),
      soon('Shipping & delivery policy'),
      soon('Grievance redressal'),
    ],
  },
];

/** Shown in the bottom bar when the pages exist. */
export const BOTTOM_LINKS: FooterLink[] = [
  soon('Terms & conditions'),
  soon('Privacy policy'),
  soon('Cookie settings'),
  { label: 'Help & support', route: '/support' },
];

export const PARTNER_CARDS = [
  {
    title: 'For restaurant owners',
    text: 'Reach more hungry customers and grow your kitchen with BiteBox.',
    icon: 'store',
    links: [
      { label: 'Register your restaurant', route: '/restaurant/register' },
      { label: 'Manage your restaurant', route: '/login' },
    ],
  },
  {
    title: 'For delivery partners',
    text: 'Deliver on your own schedule and earn on every trip.',
    icon: 'bike',
    links: [
      { label: 'Join our delivery team', route: '/delivery/register' },
      { label: 'Rider sign in', route: '/login' },
    ],
  },
] satisfies { title: string; text: string; icon: string; links: FooterLink[] }[];

const { social, apps } = environment.links;

export const SOCIAL_LINKS: FooterLink[] = [
  { label: 'Facebook', href: social.facebook, icon: 'facebook' },
  { label: 'Instagram', href: social.instagram, icon: 'instagram' },
  { label: 'YouTube', href: social.youtube, icon: 'youtube' },
  { label: 'LinkedIn', href: social.linkedin, icon: 'linkedin' },
  { label: 'X (Twitter)', href: social.x, icon: 'twitter' },
];

export const APP_LINKS: FooterLink[] = [
  { label: 'Get it on Google Play', href: apps.googlePlay, icon: 'play' },
  { label: 'Download on the App Store', href: apps.appStore, icon: 'apple' },
];

/** Only links that lead somewhere real. */
export const available = (links: FooterLink[]) =>
  links.filter((l) => (l.href !== undefined ? !!l.href : !!l.route));
