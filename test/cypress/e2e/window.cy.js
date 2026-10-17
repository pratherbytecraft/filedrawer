// The file window on a made up home folder (support/fake.js).
const HOME = 'window/index.html?path=/Users/test';
const names = () => cy.get('#files .item .nm').then((els) => [...els].map((e) => e.textContent));
const item = (name) => cy.contains('#files .item', name);
const command = (name, arg) => cy.fake().then((api) => api.emit('command', { command: name, arg }));

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

  it('dragging a header edge resizes the column and saves the widths', () => {
    cy.page(HOME);
    cy.get('#files th[data-col="name"]').then(($th) => {
      const r = $th[0].getBoundingClientRect();
      cy.get('#files th[data-col="name"] .rz').trigger('mousedown', { button: 0, clientX: r.right - 2, clientY: r.top + 5 });
      cy.document().trigger('mousemove', { clientX: r.right + 58, clientY: r.top + 5 });
      cy.document().trigger('mouseup');
      cy.calls('updateSettings').should((calls) => {
        const saved = calls.map(([p]) => p.columnWidths).find(Boolean);
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
        const saved = calls.map(([p]) => p.columnWidths).filter(Boolean).pop();
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

  it('Move to Trash takes the item away', () => {
    cy.page(HOME);
    item('photo.jpg').click();
    command('trash');
    cy.calls('trash').should('deep.equal', [[['/Users/test/photo.jpg']]]);
    item('photo.jpg').should('not.exist');
  });
});
