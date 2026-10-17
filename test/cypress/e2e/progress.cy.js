// The progress window of a copy or move, fed updates like the copier sends.
const PAGE = 'progress/index.html?id=7';
const update = (u) => cy.fake().then((api) => api.emit('job', { title: 'Copying 3 items', line: 'to "Backup"', current: '', fraction: 0, left: '', question: null, ...u }));

describe('progress window', () => {
  it('shows what is being copied, how far along and the time left', () => {
    cy.page(PAGE);
    update({ current: 'a.txt', fraction: 0.42, left: 'About 10 seconds left' });
    cy.get('#title').should('have.text', 'Copying 3 items');
    cy.get('#line').should('have.text', 'to "Backup"');
    cy.get('#current').should('have.text', 'a.txt');
    cy.get('#fill').should('have.attr', 'style').and('contain', 'width: 42%');
    cy.get('#left').should('have.text', 'About 10 seconds left');
    cy.get('#ask').should('not.be.visible');
  });

  it('Cancel and Escape stop the job', () => {
    cy.page(PAGE);
    update({});
    cy.get('#cancel').click();
    cy.get('body').type('{esc}');
    cy.calls('cancelJob').should('deep.equal', [['7'], ['7']]);
  });

  it('a taken name asks, with Do this for the others when more are coming', () => {
    cy.page(PAGE);
    update({ question: { name: 'a.txt', folder: 'Backup', more: 2 } });
    cy.get('#job').should('not.be.visible');
    cy.get('#q').should('have.text', 'There\'s already an item named "a.txt" in "Backup". Do you want to replace it?');
    cy.get('#all-text').should('have.text', 'Do this for the other 2 items too');
    cy.get('#all').check();
    cy.get('#keep').click();
    cy.calls('answerJob').should('deep.equal', [['7', 'keep', true]]);
  });

  it('with nothing else to come, the for all line stays hidden', () => {
    cy.page(PAGE);
    update({ question: { name: 'b.txt', folder: 'Backup', more: 0 } });
    cy.get('#all-row').should('not.be.visible');
    cy.get('#replace').click();
    cy.get('#skip').click();
    cy.get('#stop').click();
    cy.calls('answerJob').should('deep.equal', [['7', 'replace', false], ['7', 'skip', false], ['7', 'cancel', false]]);
  });
});
