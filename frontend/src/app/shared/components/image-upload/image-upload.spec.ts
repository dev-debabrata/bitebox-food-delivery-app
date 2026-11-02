import { TestBed } from '@angular/core/testing';
import { HttpErrorResponse } from '@angular/common/http';
import { of, throwError } from 'rxjs';
import { UploadService } from '../../../core/services/upload.service';
import { ImageUpload } from './image-upload';

type Internals = {
  url: { (): string; set: (v: string) => void };
  preview: { (): string; set: (v: string) => void };
  error: () => string | null;
  onFile: (f: File) => void;
  onRemove: () => void;
};

describe('ImageUpload', () => {
  const uploads = { validate: vi.fn(), uploadImage: vi.fn() };
  const file = new File(['x'], 'dish.png', { type: 'image/png' });

  async function create(initialUrl = '') {
    await TestBed.configureTestingModule({ imports: [ImageUpload], providers: [{ provide: UploadService, useValue: uploads }] }).compileComponents();
    const fixture = TestBed.createComponent(ImageUpload);
    fixture.componentRef.setInput('url', initialUrl);
    await fixture.whenStable();
    return fixture.componentInstance as unknown as Internals;
  }

  beforeEach(() => {
    uploads.validate.mockReset().mockReturnValue(null);
    uploads.uploadImage.mockReset();
  });

  it('stores only the server URL, never the local data-URL preview', async () => {
    uploads.uploadImage.mockReturnValue(of('http://localhost:5000/uploads/images/abc.png'));
    const c = await create();
    c.preview.set('data:image/png;base64,AAAA'); // what NexPrime shows instantly
    c.onFile(file);
    expect(c.url()).toBe('http://localhost:5000/uploads/images/abc.png');
    expect(c.preview()).toBe('http://localhost:5000/uploads/images/abc.png');
  });

  it('restores the previous image and shows the error when the upload fails', async () => {
    uploads.uploadImage.mockReturnValue(throwError(() => new HttpErrorResponse({ status: 415, error: { message: 'Only JPEG, PNG or WebP images are allowed' } })));
    const c = await create('http://localhost:5000/uploads/images/old.png');
    c.preview.set('data:image/png;base64,AAAA');
    c.onFile(file);
    expect(c.url()).toBe('http://localhost:5000/uploads/images/old.png');
    expect(c.preview()).toBe('http://localhost:5000/uploads/images/old.png');
    expect(c.error()).toContain('Only JPEG, PNG or WebP');
  });

  it('rejects unsupported files before uploading', async () => {
    uploads.validate.mockReturnValue('Choose a JPEG, PNG or WebP image');
    const c = await create();
    c.onFile(new File(['x'], 'anim.gif', { type: 'image/gif' }));
    expect(uploads.uploadImage).not.toHaveBeenCalled();
    expect(c.error()).toBe('Choose a JPEG, PNG or WebP image');
  });

  it('clears the stored URL when the image is removed', async () => {
    const c = await create('http://localhost:5000/uploads/images/old.png');
    c.onRemove();
    expect(c.url()).toBe('');
  });
});
