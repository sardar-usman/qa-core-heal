describe('login', () => {
  it('moved element', () => {
    cy.visit('/');
    cy.get('#user-name').type('a');
  });
});
