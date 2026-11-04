import { TestBed } from '@angular/core/testing';
import { BrokenImages } from './broken-images';

describe('BrokenImages', () => {
  it('treats an image as usable until it fails to load', () => {
    const images = TestBed.inject(BrokenImages);
    const url = 'http://localhost:5000/uploads/images/missing.jpg';

    expect(images.usable(url)).toBe(true);
    images.markFailed(url);
    expect(images.usable(url)).toBe(false);
    expect(images.usable('https://res.cloudinary.com/demo/cover.jpg')).toBe(true);
  });

  it('never treats an empty URL as usable', () => {
    const images = TestBed.inject(BrokenImages);
    expect(images.usable('')).toBe(false);
    expect(images.usable(null)).toBe(false);
    expect(images.usable(undefined)).toBe(false);
  });
});
