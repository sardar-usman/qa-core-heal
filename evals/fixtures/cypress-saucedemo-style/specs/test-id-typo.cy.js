describe('login', () => {
  it('test id typo', () => {
    cy.visit('/');
    cy.get('[data-test="usrname"]').type('a');
  });
});
