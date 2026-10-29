describe('login', () => {
  it.skip('old name', () => {
    cy.contains('button', 'Login').click();
  });
  it('skipped neighbour', () => {
    cy.visit('/');
    cy.get('[data-test="usrname"]').type('a');
  });
});
