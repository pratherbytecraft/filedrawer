// The file window on a made up home folder (support/fake.ts).
import type { Settings } from '../../../src/shared/types';

// The column widths a settings change carries, when it has them.
type WidthsPatch = { columnWidths?: Settings['columnWidths'] };

const HOME = 'window/index.html?path=/Users/test';
const names = () => cy.get('#files .item .nm').then((els) => [...els].map((e) => e.textContent));
const item = (name: string) => cy.contains('#files .item', name);
const command = (name: string, arg?: string) => cy.fake().then((api) => api.emit('command', { command: name, arg }));

describe('file window', () => {
  it('lists the folder without its hidden items', () => {
    cy.page(HOME);
    cy.get('#title').should('have.text', 'test');
    cy.get('#files .item').should('have.length', 5);
    names().should('include.members', ['Documents', 'Pictures', 'Projects', 'notes.txt', 'photo.jpg']);
    cy.calls('list').its(0).should('deep.include', '/Users/test');
  });

  it('shows hidden items when the setting is on', () => {
    cy.page(HOME, (state) => { state.settings.showHidden = true; });
    cy.get('#files .item').should('have.length', 6);
    item('.hidden').should('have.class', 'hid');
  });

  it('switches between every view and saves the one picked', () => {
    cy.page(HOME);
    for (const view of ['thumbs', 'tiles', 'icons', 'list', 'details']) {
      command('view', view);
      cy.get('#files').should('have.attr', 'data-view', view);
      cy.get('#files .item').should('have.length', 5);
    }
    cy.calls('updateSettings').should('deep.include', [{ view: 'icons' }]);
  });

  it('opens a folder, goes back, and goes up', () => {
    cy.page(HOME);
    item('Documents').dblclick();
    cy.get('#title').should('have.text', 'Documents');
    names().should('have.members', ['Budget.txt', 'Report.pdf']);
    cy.get('#b-back').click();
    cy.get('#title').should('have.text', 'test');
    item('Projects').dblclick();
    item('Startbar').dblclick();
    cy.get('#title').should('have.text', 'Startbar');
    cy.get('#b-up').click();
    cy.get('#title').should('have.text', 'Projects');
  });

  it('a file opens in its app', () => {
    cy.page(HOME);
    item('notes.txt').dblclick();
    cy.calls('open').should('deep.include', ['/Users/test/notes.txt']);
  });

  it('a drag from one of several selected items takes them all', () => {
    cy.page(HOME);
    item('Documents').trigger('mousedown', { button: 0 });
    item('Documents').trigger('mouseup', { button: 0 });
    item('Pictures').trigger('mousedown', { button: 0, metaKey: true });
    item('Pictures').trigger('mouseup', { button: 0, metaKey: true });
    cy.get('#files .item.sel').should('have.length', 2);
    // A press that drags keeps both; startDrag gets both paths.
    item('Documents').trigger('mousedown', { button: 0, clientX: 40, clientY: 40 });
    item('Documents').trigger('dragstart');
    cy.get('#files .item.sel').should('have.length', 2);
    cy.calls('startDrag').should('deep.include', [['/Users/test/Documents', '/Users/test/Pictures']]);
    // A press released in place narrows the selection to that item.
    item('Documents').trigger('mousedown', { button: 0, clientX: 40, clientY: 40 });
    item('Documents').trigger('mouseup', { button: 0, clientX: 40, clientY: 40 });
    cy.get('#files .item.sel').should('have.length', 1);
    item('Documents').should('have.class', 'sel');
  });

  it('the arrow keys move the selection and Return opens a folder', () => {
    cy.page(HOME);
    item('Documents').click();
    item('Documents').should('have.class', 'sel');
    cy.get('#files').type('{downarrow}');
    item('Pictures').should('have.class', 'sel');
    item('Documents').should('not.have.class', 'sel');
    cy.get('#files').type('{enter}');
    cy.get('#title').should('have.text', 'Pictures');
  });

  it('renames in place, keeping the extension picked out', () => {
    cy.page(HOME);
    item('notes.txt').click();
    command('rename');
    cy.get('#files input.ren').should('have.value', 'notes.txt').type('todo{enter}');
    cy.calls('rename').should('deep.equal', [['/Users/test/notes.txt', 'todo.txt']]);
    item('todo.txt').should('exist');
  });

  it('Escape leaves the name as it was', () => {
    cy.page(HOME);
    item('notes.txt').click();
    command('rename');
    cy.get('#files input.ren').type('nope{esc}');
    cy.calls('rename').should('have.length', 0);
    item('notes.txt').should('exist');
  });

  it('a new folder comes in with its name ready to type', () => {
    cy.page(HOME);
    command('newFolder');
    cy.calls('newFolder').should('deep.equal', [['/Users/test']]);
    cy.get('#files input.ren').should('have.value', 'New Folder').type('Music{enter}');
    cy.calls('rename').should('deep.equal', [['/Users/test/New Folder', 'Music']]);
    item('Music').should('exist');
  });

  it('the address bar suggests folders and goes where it is told', () => {
    cy.page(HOME);
    cy.get('#path').clear().type('/Users/test/P');
    cy.get('#suggest.open .row').should('have.length', 2).first().should('contain', 'Pictures');
    cy.get('#path').type('rojects{enter}');
    cy.get('#title').should('have.text', 'Projects');
  });

  it('an address that is not there says so', () => {
    cy.page(HOME);
    cy.get('#path').clear().type('/Users/test/Nowhere{enter}');
    cy.get('#addr-error').should('have.class', 'open');
    cy.get('#title').should('have.text', 'test');
  });

  it('the Hidden Files button shows hidden items and stays pressed', () => {
    cy.page(HOME);
    cy.get('#b-hidden').should('not.have.class', 'on').click();
    cy.calls('updateSettings').should('deep.include', [{ showHidden: true }]);
    cy.get('#pane [data-box="tasks"]').should('not.exist');
  });

  it('buttons that do not fit move into the More menu', () => {
    cy.viewport(1000, 600);
    cy.page(HOME);
    cy.get('#b-more').should('not.be.visible');
    cy.get('#b-hidden').should('be.visible');
    cy.viewport(540, 600);
    cy.get('#b-more').should('be.visible');
    cy.get('#b-hidden').should('not.be.visible');
    cy.get('#b-term').should('not.be.visible');
    cy.get('#b-search').should('be.visible');
    cy.get('#b-more').trigger('mousedown');
    cy.get('#menu .mi').then((els) => [...els].map((e) => e.textContent)).should('deep.equal', ['Open Terminal Here', 'Hidden Files']);
    cy.contains('#menu .mi', 'Hidden Files').click();
    cy.calls('updateSettings').should('deep.include', [{ showHidden: true }]);
    cy.viewport(1000, 600);
    cy.get('#b-more').should('not.be.visible');
    cy.get('#b-hidden').should('be.visible');
  });

  it('a header sorts only the folder it is in, and each folder keeps its own', () => {
    cy.page(HOME, (state) => { state.settings.folderSorts = { '/Users/test/Documents': { key: 'name', dir: 'desc' } }; });
    names().should('deep.equal', ['Documents', 'Pictures', 'Projects', 'notes.txt', 'photo.jpg']);
    cy.get('#files th[data-sort="name"]').should('have.class', 'asc').click();
    cy.calls('updateSettings').should('deep.include', [{ folderSorts: { '/Users/test/Documents': { key: 'name', dir: 'desc' }, '/Users/test': { key: 'name', dir: 'desc' } } }]);
    names().should('deep.equal', ['Projects', 'Pictures', 'Documents', 'photo.jpg', 'notes.txt']);
    item('Projects').dblclick();
    names().should('deep.equal', ['Filedrawer', 'Startbar']);
    cy.get('#b-back').click();
    item('Documents').dblclick();
    names().should('deep.equal', ['Report.pdf', 'Budget.txt']);
    cy.get('#files th[data-sort="name"]').should('have.class', 'desc');
  });

  it("a header's right click turns that folder's columns on and off", () => {
    const heads = () => cy.get('#files th').then((els) => [...els].map((e) => e.textContent));
    cy.page(HOME);
    heads().should('deep.equal', ['Name', 'Size', 'Kind', 'Date Modified']);
    cy.get('#files th[data-col="kind"]').rightclick();
    cy.get('#menu .mi').then((els) => [...els].map((e) => e.textContent)).should('deep.equal', ['Name', 'Size', 'Kind', 'Date Modified', 'Date Created', 'Date Added']);
    cy.contains('#menu .mi', 'Name').should('have.class', 'disabled').and('have.class', 'chk');
    cy.contains('#menu .mi', 'Date Added').should('not.have.class', 'chk').click();
    cy.calls('updateSettings').should('deep.include', [{ folderColumns: { '/Users/test': ['size', 'kind', 'modified', 'added'] } }]);
    heads().should('deep.equal', ['Name', 'Size', 'Kind', 'Date Modified', 'Date Added']);
    cy.get('#files th[data-col="size"]').rightclick();
    cy.contains('#menu .mi', 'Date Modified').click();
    heads().should('deep.equal', ['Name', 'Size', 'Kind', 'Date Added']);
    item('Documents').dblclick();
    heads().should('deep.equal', ['Name', 'Size', 'Kind', 'Date Modified']);
  });

  it('Downloads starts with Date Added, newest first', () => {
    cy.page('window/index.html?path=/Users/test/Downloads', (state, extra) => {
      extra.tree = { '/Users/test': ['Downloads/'], '/Users/test/Downloads': ['a.zip', 'longer.zip', 'mid.zip'] };
    });
    cy.get('#files th').then((els) => [...els].map((e) => e.textContent)).should('deep.equal', ['Name', 'Size', 'Kind', 'Date Added']);
    cy.get('#files th[data-sort="added"]').should('have.class', 'desc');
    names().should('deep.equal', ['a.zip', 'mid.zip', 'longer.zip']);
  });

  it('turning off the sorted column goes back to sorting by name', () => {
    cy.page(HOME, (state) => { state.settings.folderSorts = { '/Users/test': { key: 'modified', dir: 'desc' } }; });
    names().should('deep.equal', ['Documents', 'Projects', 'Pictures', 'photo.jpg', 'notes.txt']);
    cy.get('#files th[data-col="name"]').rightclick();
    cy.contains('#menu .mi', 'Date Modified').click();
    cy.calls('updateSettings').should('deep.include', [{ folderColumns: { '/Users/test': ['size', 'kind'] }, folderSorts: {} }]);
    names().should('deep.equal', ['Documents', 'Pictures', 'Projects', 'notes.txt', 'photo.jpg']);
  });

  it('arranging by a date the folder does not show turns that column on', () => {
    cy.page(HOME);
    command('sort', 'created');
    cy.calls('updateSettings').should('deep.include', [{
      folderSorts: { '/Users/test': { key: 'created', dir: 'asc' } }, folderColumns: { '/Users/test': ['size', 'kind', 'modified', 'created'] }
    }]);
    cy.get('#files th[data-sort="created"]').should('have.class', 'asc');
  });

  it('dragging a header edge resizes the column and saves the widths', () => {
    cy.page(HOME);
    cy.get('#files th[data-col="name"]').then(($th) => {
      const r = $th[0].getBoundingClientRect();
      cy.get('#files th[data-col="name"] .rz').trigger('mousedown', { button: 0, clientX: r.right - 2, clientY: r.top + 5 });
      cy.document().trigger('mousemove', { clientX: r.right + 58, clientY: r.top + 5 });
      cy.document().trigger('mouseup');
      cy.calls('updateSettings').should((calls) => {
        // Until a call with widths comes in, saved! throws and should() tries again, as before.
        const saved = calls.map(([p]) => (p as WidthsPatch).columnWidths).find(Boolean)!;
        expect(saved.files.name).to.be.closeTo(r.width + 60, 1);
        expect(Object.keys(saved.files)).to.deep.equal(['name', 'size', 'kind', 'modified']);
      });
      cy.get('#files col').first().should('have.attr', 'style').and('match', /width: ?\d+px/);
    });
  });

  it('a double click on a header edge fits the column to its longest entry', () => {
    cy.page(HOME);
    cy.get('#files th[data-col="name"]').then(($th) => {
      const before = $th[0].getBoundingClientRect().width;
      cy.get('#files th[data-col="name"] .rz').dblclick();
      cy.calls('updateSettings').should((calls) => {
        // As above, saved! throws until a call with widths comes in.
        const saved = calls.map(([p]) => (p as WidthsPatch).columnWidths).filter(Boolean).pop()!;
        expect(saved.files.name).to.be.within(60, before - 1);
      });
    });
  });

  it('the Trash has an Empty Trash button that other folders leave out', () => {
    cy.page('window/index.html?path=::trash', (state, extra) => {
      extra.tree = { '/Users/test': ['Documents/'], '/Users/test/Documents': [], '::trash': ['old.txt'] };
    });
    cy.get('#b-empty').should('be.visible').and('not.have.class', 'off').click();
    cy.calls('emptyTrash').should('have.length', 1);
    cy.get('#path').type('/Users/test/Documents{enter}');
    cy.get('#title').should('have.text', 'Documents');
    cy.get('#b-empty').should('not.be.visible');
  });

  it('Empty Trash is greyed out while the Trash is empty', () => {
    cy.page('window/index.html?path=::trash', (state, extra) => {
      extra.tree = { '/Users/test': [], '::trash': [] };
    });
    cy.get('#b-empty').should('be.visible').and('have.class', 'off');
  });

  it('pictures show a preview in place of their icon in every view', () => {
    cy.page(HOME);
    for (const view of ['icons', 'tiles', 'list', 'details']) {
      command('view', view);
      cy.get('#files').should('have.attr', 'data-view', view);
      item('photo.jpg').find('.pv img').should('have.attr', 'src').and('match', /^data:image/);
      item('notes.txt').find('.pv').should('not.exist');
      item('Documents').find('.pv').should('not.exist');
    }
    cy.calls('thumbs').should((calls) => expect(calls.map(([, px]) => px)).to.include.members([36]));
  });

  it('with previews off, files keep their icons outside Thumbnails', () => {
    cy.page(HOME, (state) => { state.settings.previews = false; });
    command('view', 'icons');
    item('photo.jpg').find('img.big').should('exist');
    item('photo.jpg').find('.pv').should('not.exist');
    command('view', 'thumbs');
    item('photo.jpg').find('.frame img.pic').should('exist');
  });

  it('a new tab opens on the start folder and tabs switch', () => {
    cy.page(HOME);
    item('Documents').dblclick();
    cy.get('#title').should('have.text', 'Documents');
    command('newTab');
    cy.get('#tabstrip .tab').should('have.length', 2);
    cy.get('#title').should('have.text', 'test');
    cy.get('#tabstrip .tab').first().click();
    cy.get('#title').should('have.text', 'Documents');
  });

  it('Two Panes shows a second folder beside the first', () => {
    cy.page(HOME);
    cy.get('#side-r').should('not.be.visible');
    cy.get('#b-split').click();
    cy.get('#side-r').should('be.visible');
    cy.get('#files-other .item').should('have.length.greaterThan', 0);
  });

  it('a ticked site shows in Sites with its dot and opens like a folder', () => {
    const site = (id: string, name: string, shown: boolean) => ({
      id, name, host: 'homelab.local', port: 22, user: 'me', from: 'config' as const, shown,
      logon: 'agent' as const, key: '', start: '', local: '', proxy: false
    });
    cy.page(HOME, (state, extra) => {
      state.sites = [site('ssh-lab', 'homelab', true), site('ssh-other', 'other', false)];
      state.siteStatus = { 'ssh-lab': true };
      extra.tree = {
        '/Users/test': ['Documents/'],
        '::site/ssh-lab/home/me': ['Media/', 'notes.md', '.profile'],
        '::site/ssh-lab/home': ['me/']
      };
    });
    cy.get('[data-box="sites"] [data-site]').should('have.length', 1).and('contain.text', 'homelab');
    cy.get('[data-box="sites"] [data-sitemanager]').should('contain.text', 'Site Manager');
    cy.get('[data-box="sites"] .dot').should('have.class', 'up');
    cy.get('[data-box="sites"] [data-site]').click();
    cy.calls('siteHome').should('deep.equal', [['ssh-lab']]);
    cy.get('#title').should('have.text', 'me');
    cy.get('#path').should('have.value', 'me@homelab.local:/home/me');
    names().should('have.members', ['Media', 'notes.md']);
    cy.get('#st3').should('have.text', 'Connected to homelab.local');
    cy.get('[data-box="sites"] [data-site]').should('have.class', 'here');
    cy.get('#b-up').click();
    cy.get('#path').should('have.value', 'me@homelab.local:/home');
    // The server stops answering: the dot goes grey.
    cy.fake().then((api) => api.emit('siteStatus', { 'ssh-lab': false }));
    cy.get('[data-box="sites"] .dot').should('have.class', 'down');
    cy.get('[data-box="sites"] [data-sitemanager]').click();
    cy.calls('openSiteManager').should('have.length', 1);
  });

  it('a site that can\'t be reached says why and can be tried again', () => {
    cy.page('window/index.html?path=::site/ssh-lab/home/me', (state) => {
      state.sites = [{ id: 'ssh-lab', name: 'homelab', host: 'homelab.local', port: 22, user: 'me', from: 'config', shown: true, logon: 'agent', key: '', start: '', local: '', proxy: false }];
    });
    cy.fake().then((api) => {
      api.list = ((dir: string) => {
        api.calls.push(['list', dir]);
        return Promise.resolve({ path: dir, error: 'offline', message: 'homelab.local isn\'t answering.' });
      }) as typeof api.list;
    });
    cy.fake().then((api) => api.emit('command', { command: 'refresh' }));
    cy.get('#files .note').should('contain.text', 'homelab.local isn\'t answering.');
    cy.get('#b-retry').click();
    cy.calls('list').its('length').should('be.greaterThan', 1);
  });

  it('on a site, a file\'s menu says Delete, leaves out what needs the Mac, and Delete asks the main process', () => {
    cy.page('window/index.html?path=::site/ssh-lab/home/me', (state, extra) => {
      state.sites = [{ id: 'ssh-lab', name: 'homelab', host: 'homelab.local', port: 22, user: 'me', from: 'config', shown: true, logon: 'agent', key: '', start: '', local: '', proxy: false }];
      extra.tree = { '::site/ssh-lab/home/me': ['notes.md', 'Media/'] };
    });
    item('notes.md').rightclick();
    cy.get('#menu .mi').then((els) => [...els].map((e) => e.textContent)).should('include', 'Delete...')
      .and('not.include', 'Move to Trash').and('not.include', 'Make Alias').and('not.include', 'Send To').and('not.include', 'Quick Look');
    cy.contains('#menu .mi', 'Delete...').click();
    cy.calls('trash').should('deep.equal', [[['::site/ssh-lab/home/me/notes.md']]]);
    // Date Created and Date Added can't be picked for a site's columns.
    cy.get('#files th[data-col="name"]').rightclick();
    cy.contains('#menu .mi', 'Date Created').should('have.class', 'disabled');
    cy.contains('#menu .mi', 'Date Added').should('have.class', 'disabled');
  });

  it('Move to Trash takes the item away', () => {
    cy.page(HOME);
    item('photo.jpg').click();
    command('trash');
    cy.calls('trash').should('deep.equal', [[['/Users/test/photo.jpg']]]);
    item('photo.jpg').should('not.exist');
  });
});
